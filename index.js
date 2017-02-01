"use strict";

// @IMPORTS
const Application = require("neat-base").Application;
const Module = require("neat-base").Module;
const Tools = require("neat-base").Tools;
const multer = require('multer');
const mkdirp = require('mkdirp');
const fs = require('fs');
const path = require("path");
const queryParser = require("url").parse;
const Distributor = require("distribute-files").Distributor;
const mime = require("mime");
const request = require('request');
const crypto = require("crypto");
const Promise = require("bluebird");

module.exports = class Files extends Module {

    static defaultConfig() {
        return {
            uploadDir: "/data/uploads",
            imagesDir: "/data/images",
            fileDir: "/data/files",
            dbModuleName: "database",
            uploadRoute: "/upload",
            authModuleName: "auth",
            webserverModuleName: "webserver",
            uploadRequiresAuth: true,
            uploadRequiresPermission: true,
            limits: {
                fileSize: 5
            }
        }
    }

    /**
     *
     */
    init() {
        return new Promise((resolve, reject) => {
            this.log.debug("Initializing...");

            // setup models
            Application.modules[this.config.dbModuleName].registerModel("file", require("./models/file.js"));

            // setup upload and uploaded Paths
            this.uploadTarget = Application.config.root_path + this.config.uploadDir;
            this.fileDir = Application.config.root_path + this.config.fileDir;

            // setup multer
            let uploader = multer({
                dest: this.uploadTarget,
                limits: {
                    fileSize: this.config.limits.fileSize * 1024 * 1024
                }
            });

            // Setup distributor for file distribution if available / required
            if (this.config.distributeConfig) {
                if (typeof this.config.distributeConfig === "object") {
                    this.distributor = new Distributor(this.config.distributeConfig);
                } else {
                    let conf = null;
                    try {
                        conf = fs.readFileSync(this.config.distributeConfig);
                        conf = JSON.parse(conf);
                    } catch (e) {
                        this.log.error("Error while loading " + this.config.distributeConfig);
                        throw e;
                    }

                    if (!conf) {
                        this.log.error("Error while loading " + this.config.distributeConfig);
                    } else if (!conf[this.config.distributeKey]) {
                        this.log.error("Distribute config key doesnt exist " + this.config.distributeKey);
                    } else {
                        this.distributor = new Distributor({
                            debug: this.config.distributeDebug || false,
                            root: Application.config.root_path,
                            servers: conf[this.config.distributeKey].servers
                        });
                        this.distributorGenerated = new Distributor({
                            debug: this.config.distributeDebug || false,
                            root: Application.config.root_path,
                            servers: conf[this.config.distributeKeyGenerated].servers
                        });
                    }
                }
            }

            // create any missing directories (sync because its startup after all)
            mkdirp.sync(this.uploadTarget);
            mkdirp.sync(this.fileDir);

            /*
             Routes
             */
            if (Application.modules[this.config.webserverModuleName]) {
                // upload a single file
                Application.modules[this.config.webserverModuleName].addRoute("post", this.config.uploadRoute, uploader.single('file'), (req, res) => {
                    if (!req.file) {
                        res.status(400);
                        return res.end("No file was uploaded");
                    }

                    // if configured require an authed user to allow upload
                    if (this.config.uploadRequiresAuth && !req.user) {
                        res.status(401);
                        return res.end();
                    }

                    // check if the user actually has access to the upload (if configured)
                    if (this.config.uploadRequiresPermission && !Application.modules[this.config.authModuleName].hasPermission(req, "file", "save")) {
                        res.status(401);
                        return res.end();
                    }

                    this.saveUploadedFile(req.file, req.body, req).then((data) => {
                        res.json(data);
                    }, (err) => {
                        res.err(err);
                    });
                }, 9999);
            }

            resolve(this);
        });
    }

    /**
     * Properties can contain a name for the file, if none is given the originalfilename will be taken
     *
     *
     * @param object uploadedFileObj
     * @param object properties
     * @param Request req
     */
    saveUploadedFile(uploadedFileObj, properties, req) {
        properties = properties || {};

        return new Promise((resolve, reject) => {
            let model = Application.modules[this.config.dbModuleName].getModel("file");
            let getFileObjectPromise;
            let originalGetFileObjectPromise = new Promise((resolve, reject) => {
                try {
                    resolve(new model({
                        name: properties.name || uploadedFileObj.originalname,
                        originalname: uploadedFileObj.originalname,
                        type: this.getTypeFromMimeType(uploadedFileObj.mimetype),
                        filesize: uploadedFileObj.size,
                        mimetype: uploadedFileObj.mimetype,
                        extension: this.getExtensionFromMimeType(uploadedFileObj.mimetype)
                    }));
                } catch (e) {
                    this.log.error(e);
                    return reject(e);
                }
            });

            if (req.body._id) {
                getFileObjectPromise = new Promise((resolve, reject) => {
                    try {
                        return model.findOne({
                            _id: req.body._id
                        }).then((doc) => {

                            if (!doc) {
                                return originalGetFileObjectPromise().then(resolve, reject);
                            }

                            resolve(doc);
                        }, reject);
                    } catch (e) {
                        this.log.error(e);
                    }
                });
            } else {
                getFileObjectPromise = originalGetFileObjectPromise;
            }

            getFileObjectPromise.then((newFile) => {

                for (var field in properties) {
                    var value = properties[field];

                    if ([
                            "originalname",
                            "type",
                            "mimetype",
                            "extension"
                        ].indexOf(field) !== -1) {
                        continue;
                    }

                    newFile.set(field, value);

                }

                newFile.save().then(() => {

                    try {
                        fs.unlinkSync(this.fileDir + "/" + newFile.filename);
                    } catch (e) {
                        // file existed, we just deleted to make sure it didnt exist, so ignore happens in case of replacements
                    }

                    fs.rename(uploadedFileObj.path, this.fileDir + "/" + newFile.filename, (err) => {
                        if (err) {
                            fs.unlinkSync(uploadedFileObj.path);
                            return reject(err);
                        }

                        if (this.distributor) {
                            return this.distributor.distributeFile(newFile.get("filepath"), newFile.get("filepath")).then(() => {
                                this.log.debug("Distributed File " + newFile.get("filepath"));
                                return resolve(newFile);
                            }, (e) => {
                                this.log.error("Distribution of file " + newFile.get("filepath") + " failed!");
                                this.log.error(e);
                                return resolve(newFile);
                            });
                        } else {
                            return resolve(newFile);
                        }
                    });
                }, reject);
            }, reject);
        });
    }

    /**
     *
     * @param mimetype
     */
    getExtensionFromMimeType(mimetype) {
        if (typeof mimetype !== "string") {
            mimetype = "";
        }

        return mime.extension(mimetype);
    }

    /**
     *
     * @param mimetype
     * @returns {*}
     */
    getTypeFromMimeType(mimetype) {

        if (typeof mimetype !== "string") {
            mimetype = "";
        }

        var imageIdentifiers = [
            "jpg",
            "jpeg",
            "gif",
            "bmp",
            "png"
        ];

        for (let i = 0; i < imageIdentifiers.length; i++) {
            let identifier = imageIdentifiers[i];

            if (mimetype.indexOf(identifier) !== -1) {
                return "image";
            }
        }

        return "misc";
    }

    /**
     *
     * @param url
     */
    importFromUrl(url, newFile) {
        let reqPromise = new Promise((resolve, reject) => {
            var model = Application.modules[this.config.dbModuleName].getModel("file");
            var requestUrl = url;
            if (typeof url == 'object') {
                requestUrl = url.url
            }

            newFile = newFile || new model();

            var hashed = crypto.createHash("md5");
            hashed.update(requestUrl);
            hashed = hashed.digest("hex");
            var parsedUrl = queryParser(requestUrl);
            var parsedPath = path.parse(parsedUrl.pathname);
            var targetTempPath = path.join(this.uploadTarget, (new Date().getTime()) + hashed + parsedPath.ext);

            this.log.debug("Downloading " + requestUrl);
            return request(url).on("response", (res) => {
                if (res.statusCode === 404) {
                    this.log.error("404, File not found %s", requestUrl);
                    return reject(new Error("404, File not found"));
                }

                return res;
            }).pipe(fs.createWriteStream(targetTempPath)).on('close', (err) => {
                if (err) {
                    this.log.error(err);
                    return reject(new Error(err.toString()));
                }

                // Was already rejected, do nothing
                if (reqPromise.isRejected()) {
                    return;
                }

                var stats = fs.statSync(targetTempPath);
                var fileSizeInBytes = stats["size"];

                var mimetype = mime.lookup(targetTempPath);
                var type = this.getTypeFromMimeType(mimetype);

                try {
                    newFile.set("name", parsedPath.name);
                    newFile.set("originalname", parsedPath.name + parsedPath.ext);
                    newFile.set("type", type);
                    newFile.set("mimetype", mimetype);
                    newFile.set("filesize", fileSizeInBytes);
                    newFile.set("extension", parsedPath.ext.substr(1).toLowerCase() || 'jpg');
                } catch (e) {
                    this.log.error(e);
                    return reject(e);
                }

                this.log.debug("Saving File in DB %s", parsedPath.name);
                return newFile.save().then(() => {
                    this.log.debug("Saved, moving file to target location");

                    try {
                        fs.unlinkSync(this.fileDir + "/" + newFile.filename);
                    } catch (e) {
                        // file existed, we just deleted to make sure it didnt exist, so ignore
                    }

                    fs.rename(targetTempPath, this.fileDir + "/" + newFile.filename, (err) => {
                        if (err) {
                            try {
                                fs.unlinkSync(targetTempPath);
                            } catch (e) {
                                this.log.error(e);
                            }

                            this.log.error(err);
                            return reject(err);
                        }

                        this.log.debug("Moved File to target Location!");

                        if (this.distributor) {
                            this.distributor.distributeFile(newFile.get("filepath"), newFile.get("filepath")).then(() => {
                                this.log.debug("Distributed File " + newFile.get("filepath"));
                                resolve(newFile);
                            }, (e) => {
                                this.log.error("Distribution of file " + newFile.get("filepath") + " failed!");
                                this.log.error(e);
                                resolve(newFile);
                            });
                        } else {
                            resolve(newFile);
                        }
                    });
                }, (err) => {
                    reject(new Error(err.toString()))
                });
            });

        });

        return reqPromise;
    }


    /**
     *
     * @param name
     * @param schema
     */
    modifySchema(name, schema) {
        if (name === "file") {
            let self = this;

            schema.virtual("filename").get(function () {
                return this._id + "." + this.extension;
            });

            schema.virtual("filepath").get(function () {
                return self.config.fileDir + "/" + this.filename;
            });

            schema.pre("remove", function (next) {
                let fullFilePath = Application.config.root_path + this.filepath;
                try {
                    fs.unlink(fullFilePath);
                } catch (e) {

                }
                next();
            });
        }
    }
}