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
            debug: false,
            limits: {
                fileSize: 5,
            },
        };
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
            try {
                let uploader = multer({
                    dest: this.uploadTarget,
                    limits: {
                        fileSize: this.config.limits.fileSize * 1024 * 1024,
                    },
                });
            } catch (e) {
                this.log.warn(e);
            }

            // Setup distributor for file distribution if available / required
            if (this.config.distributeConfig) {
                if (typeof this.config.distributeConfig === "object") {
                    this.distributor = new Distributor({
                        debug: this.config.distributeDebug || false,
                        root: Application.config.root_path,
                        errordir: this.config.distributeConfig[this.config.distributeKey].errordir,
                        servers: this.config.distributeConfig[this.config.distributeKey].servers,
                    });
                    this.distributorGenerated = new Distributor({
                        debug: this.config.distributeDebug || false,
                        root: Application.config.root_path,
                        errordir: this.config.distributeConfig[this.config.distributeKeyGenerated].errordir,
                        servers: this.config.distributeConfig[this.config.distributeKeyGenerated].servers,
                    });
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
                            servers: conf[this.config.distributeKey].servers,
                            errordir: conf[this.config.distributeKey].errordir,
                        });
                        this.distributorGenerated = new Distributor({
                            debug: this.config.distributeDebug || false,
                            root: Application.config.root_path,
                            servers: conf[this.config.distributeKeyGenerated].servers,
                            errordir: conf[this.config.distributeKeyGenerated].errordir,
                        });
                    }
                }
            }

            // create any missing directories (sync because its startup after all)
            try {
                mkdirp.sync(this.uploadTarget);
                mkdirp.sync(this.fileDir);
            } catch (e) {
                this.log.warn(e);
            }

            /*
             Routes
             */
            if (Application.modules[this.config.webserverModuleName]) {
                // upload a single file
                let singleUpload = uploader.single('file');
                Application.modules[this.config.webserverModuleName].addRoute("post", this.config.uploadRoute, (req, res) => {

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

                    if (this.config.debug) {
                        this.log.info("Upload route");
                        this.log.info("Headers", req.headers);
                        this.log.info("Body", req.body);
                        this.log.info("Querystring", req.query);
                    }
                    singleUpload(req, res, (err) => {
                        if (err) {
                            if (this.config.debug) {
                                this.log.error("Error while uploading the file " + err.toString());
                            }
                            res.status(500);
                            return res.end("Error while uploading the file " + err.toString());
                        }

                        if (!req.file) {
                            if (this.config.debug) {
                                this.log.error("No file was uploaded");
                            }
                            res.status(400);
                            return res.end("No file was uploaded");
                        }

                        if (this.config.debug) {
                            this.log.error("File Uploaded");
                        }

                        this.saveUploadedFile(req.file, req.body, req).then((data) => {

                            if (this.config.debug) {
                                this.log.error("File Saved");
                            }

                            res.json(data);
                        }, (err) => {
                            res.err(err);
                        });
                    });
                }, 9999);
            }

            resolve(this);
        });
    }

    getFileSizeFromBase64(string) {
        if (typeof string !== 'string') {
            return 0;
        }

        return parseInt((string).replace(/=/g, "").length * 0.75);
    }

    decodeBase64(string) {
        let matches = string.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
        let response = {};

        if (matches.length !== 3) {
            return new Error('Invalid input string');
        }

        response.type = matches[1];
        response.data = new Buffer(matches[2], 'base64');

        return response;
    }

    distributionQueue() {
        let queues = [];

        if (this.distributor) {
            queues.push(this.distributor.processQueue());
        }

        if (this.distributorGenerated) {
            queues.push(this.distributorGenerated.processQueue());
        }

        return Promise.all(queues);
    }

    saveFileFromBase64(string, userId, username) {
        return new Promise((resolve, reject) => {
            let decoded = this.decodeBase64(string);
            let model = Application.modules[this.config.dbModuleName].getModel("file");
            let name = new Application.modules[this.config.dbModuleName].mongoose.Types.ObjectId().toString();
            let mimetype = decoded.type;
            let doc = new model({
                name: name,
                _createdBy: userId,
                credit: username,
                originalname: name,
                type: this.getTypeFromMimeType(mimetype),
                filesize: this.getFileSizeFromBase64(string),
                mimetype: mimetype,
                extension: this.getExtensionFromMimeType(mimetype),
            });

            doc.save().then(() => {
                try {
                    fs.writeFileSync(this.fileDir + "/" + doc.filename, decoded.data);
                } catch (e) {
                    doc.remove();
                    return reject(err);
                }

                if (this.distributor) {
                    return this.distributor.distributeFile(doc.get("filepath"), doc.get("filepath")).then(() => {
                        this.log.debug("Distributed File " + doc.get("filepath"));
                        return resolve(doc);
                    }, (e) => {
                        this.log.error("Distribution of file " + doc.get("filepath") + " failed!");
                        this.log.error(e);
                        return resolve(doc);
                    });
                } else {
                    return resolve(doc);
                }
            }, reject);
        });
    }

    saveFileFromLocalPath(sourcePath) {
        return new Promise((resolve, reject) => {
            let stats = fs.statSync(sourcePath);
            let content = fs.readFileSync(sourcePath);
            let parts = path.parse(sourcePath);
            let model = Application.modules[this.config.dbModuleName].getModel("file");
            let mimetype = this.getMimeTypeFromFilename(parts.base);
            let doc = new model({
                name: parts.name,
                originalname: parts.name,
                type: this.getTypeFromMimeType(mimetype),
                filesize: stats.size,
                mimetype: mimetype,
                extension: this.getExtensionFromMimeType(mimetype),
            });

            doc.save().then(() => {
                try {
                    fs.writeFileSync(this.fileDir + "/" + doc.filename, content);
                } catch (e) {
                    doc.remove();
                    return reject(err);
                }

                if (this.distributor) {
                    return this.distributor.distributeFile(doc.get("filepath"), doc.get("filepath")).then(() => {
                        this.log.debug("Distributed File " + doc.get("filepath"));
                        return resolve(doc);
                    }, (e) => {
                        this.log.error("Distribution of file " + doc.get("filepath") + " failed!");
                        this.log.error(e);
                        return resolve(doc);
                    });
                } else {
                    return resolve(doc);
                }
            }, reject);
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
                        extension: this.getExtensionFromMimeType(uploadedFileObj.mimetype),
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
                            _id: req.body._id,
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
                        "extension",
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
     */
    getMimeTypeFromFilename(filename) {
        if (typeof filename !== "string") {
            filename = "";
        }

        return mime.lookup(filename);
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

        if (mimetype.indexOf("image") !== -1) {
            return "image";
        }

        if (mimetype.indexOf("video") !== -1) {
            return "video";
        }

        if (mimetype.indexOf("audio") !== -1) {
            return "audio ";
        }

        return "misc";
    }

    /**
     *
     * @param url
     */
    importFromUrl(url, newFile, extension) {
        let reqPromise = new Promise((resolve, reject) => {
            var model = Application.modules[this.config.dbModuleName].getModel("file");
            var requestUrl = url;
            if (typeof url == 'object') {
                requestUrl = url.url;
            }

            newFile = newFile || new model();

            var hashed = crypto.createHash("md5");
            hashed.update(requestUrl);
            hashed = hashed.digest("hex");
            var parsedUrl = queryParser(requestUrl);
            var parsedPath = path.parse(parsedUrl.pathname);
            extension = extension || parsedPath.ext;
            var targetTempPath = path.join(this.uploadTarget, (new Date().getTime()) + hashed + extension);

            this.log.debug("Downloading " + requestUrl);
            return request(url).on("response", (res) => {
                if (res.statusCode !== 200) {
                    this.log.error(res.statusCode + ", %s", requestUrl);
                    return reject(new Error(res.statusCode + " - Could not download image"));
                }

                return res;
            }).pipe(fs.createWriteStream(targetTempPath)).on('close', (err) => {
                if (err) {
                    this.log.error(err);
                    return reject(new Error(err.toString()));
                }

                // Was already rejected, do nothing
                if (reqPromise.isRejected()) {
                    try {
                        fs.unlinkSync(targetTempPath);
                    } catch (e) {
                        this.log.warn(e);
                    }
                    return;
                }

                var stats = fs.statSync(targetTempPath);
                var fileSizeInBytes = stats["size"];

                var mimetype = mime.lookup(targetTempPath);
                var type = this.getTypeFromMimeType(mimetype);

                try {
                    newFile.set("name", parsedPath.name);
                    newFile.set("originalname", parsedPath.name + extension);
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
                    reject(new Error(err.toString()));
                });
            });

        });

        return reqPromise;
    }

    /**
     *
     * @param path
     * @param newFile
     */
    importFile(filePath, newFile) {
        let reqPromise = new Promise((resolve, reject) => {
            let model = Application.modules[this.config.dbModuleName].getModel("file");
            let hashed = crypto.createHash("md5");

            newFile = newFile || new model();
            hashed.update(filePath);
            hashed = hashed.digest("hex");

            let parsedPath = path.parse(filePath);
            let targetTempPath = path.join(this.uploadTarget, (new Date().getTime()) + hashed + parsedPath.ext);

            this.log.debug("Copying file to temp path " + targetTempPath);
            try {
                fs.writeFileSync(targetTempPath, fs.readFileSync(filePath));
            } catch (e) {
                reject(e);
            }

            let stats = fs.statSync(targetTempPath);
            let fileSizeInBytes = stats["size"];
            let mimetype = mime.lookup(targetTempPath);
            let type = this.getTypeFromMimeType(mimetype);

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
                reject(new Error(err.toString()));
            });

        });

        return reqPromise;
    }

    /**
     *
     * @param fileReadStream
     * @param newFile
     * @param fileName
     */
    importFileFromStream(fileReadStream, newFile, fileName) {
        return new Promise((resolve, reject) => {
            let hashed = crypto.createHash("md5");
            hashed.update(fileName);
            hashed = hashed.digest("hex");
            let parsedPath = path.parse(fileName);
            let targetTempPath = path.join(this.uploadTarget, (new Date().getTime()) + hashed + parsedPath.ext);

            this.log.debug("Copying file to temp path " + targetTempPath);
            try {
                let writeStream = fs.createWriteStream(targetTempPath);
                fileReadStream.pipe(writeStream);
                writeStream.on('finish', () => {
                    return this.importFile(targetTempPath, newFile).then((file) => {
                        try {
                            fs.unlinkSync(targetTempPath);
                        } catch (e) {
                            // file existed, we just deleted to make sure it didnt exist, so ignore
                        }

                        return resolve(file);
                    });
                });
            } catch (e) {
                return reject(e);
            }
        });
    }

    /**
     *
     * @param name
     * @param schema
     */
    modifySchema(name, schema) {
        let self = this;

        if (name === "file") {
            let self = this;

            schema.virtual("filename").get(function () {
                return this._id + "." + this.extension;
            });

            schema.virtual("filepath").get(function () {
                return self.config.fileDir + "/" + this.filename;
            });

            schema.pre("remove", function (next) {

                let measureTime = Date.now();

                let timeout = setTimeout(() => {
                    self.log.info("WARNING: Task removeLocalAndDistributed timed out! Removing document...");
                    return next();
                }, 30000);

                self.removeLocalAndDistributed(this).then(() => {
                    clearTimeout(timeout);
                    self.log.info("SUCCESS: removeLocalAndDistributed DONE! (" + parseInt(Date.now() - measureTime) + " ms)");
                    next();
                }).catch((e) => {
                    clearTimeout(timeout);
                    self.log.info("ERROR: removeLocalAndDistributed! (" + parseInt(Date.now() - measureTime) + " ms)");
                    console.log(e);
                    next();
                });
            });
        } else {
            /**
             * get all file docs connected to current document as an Object with the path as the key
             *
             * @returns {bluebird}
             */
            schema.methods.getConnectedFiles = function () {
                return new Promise((resolve, reject) => {
                    let files = {};
                    let currentModel = Application.modules[self.config.dbModuleName].getModel(name);
                    let possiblePaths = Application.modules[self.config.dbModuleName].getPossibleLinkPathsFromModel(currentModel, "file");

                    return currentModel.populate(this, Object.keys(possiblePaths)).then(() => {
                        for (let path in possiblePaths) {
                            let val = this.get(path);

                            if (val) {
                                if (val instanceof Array && val.length) {
                                    files[path] = val;
                                }
                            }
                        }

                        return resolve(files);
                    });
                });
            };
        }
    }

    cleanup(page, limit) {
        return new Promise((resolve, reject) => {
            page = page || 0;
            limit = limit || 5;
            let model = Application.modules[this.config.dbModuleName].getModel("file");

            return model.find().sort({_id: -1}).limit(limit).skip(page * limit).then((docs) => {
                return Promise.map(docs, (doc) => {
                    return doc.getLinked().then((links) => {
                        return new Promise((res, rej) => {
                            if (links) {
                                return res();
                            }
                            this.log.debug("Removing document " + doc._id);
                            doc.remove(() => {
                                this.log.info("SUCCESS: Removed all files and document " + doc._id);
                                return res();
                            });
                        });
                    });
                }).then(() => {
                    if (docs.length < limit) {
                        this.log.info("Script finished successfully!");
                        return resolve();
                    }

                    page++;
                    this.log.info("Processing next page... (" + page + ")");
                    return this.cleanup(page, limit);
                }, reject);
            });
        });
    }

    removeLocalAndDistributed(doc) {
        return new Promise((resolve, reject) => {
            let tasks = [];

            let packagePaths = {};
            let imagePaths = [];
            let fullFilePathsLocal = [];

            if (Application.modules.imageserver) {
                packagePaths = Application.modules.imageserver.getPaths(doc, true) || {};
            }

            packagePaths["localFile" + doc._id] = doc.filepath;

            // Collect paths
            for (let key in packagePaths) {

                let fullFilePath = Application.config.root_path + packagePaths[key];
                fullFilePath = path.resolve(fullFilePath);

                imagePaths.push(packagePaths[key]);
                fullFilePathsLocal.push(fullFilePath);
            }

            // Task 1 - Local files
            tasks.push((() => {
                return new Promise((res, rej) => {
                    return Promise.mapSeries(fullFilePathsLocal, (filePathLocal) => {
                        return new Promise((reso, reje) => {
                            fs.unlink(filePathLocal, (e) => {
                                this.log.debug("Unlinking local file: " + filePathLocal);
                                if (!e) {
                                    this.log.debug("Success! Local file unlinked successfully!");
                                } else {
                                    this.log.debug("Failed! Unlink of local file failed. ( " + e.toString() + " )");
                                }
                                return reso();
                            });
                        });
                    }).then(() => {
                        return res();
                    }).catch((e) => {
                        return res();
                    });
                });
            })());


            if (this.distributor) {
                tasks.push((() => {
                    return new Promise((res, rej) => {
                        return this.distributor.removeFiles(imagePaths, 1).then(() => {
                            this.log.info("Removed " + imagePaths.length + " original images on all distribute servers!");
                            return res();
                        }).catch((e) => {
                            // catch error, ignore failure
                            this.log.debug("Removing files on server failed: " + imagePaths.join(" , "));
                            return res();
                        });
                    });
                })());
            }

            if (this.distributorGenerated) {
                tasks.push((() => {
                    return new Promise((res, rej) => {
                        return this.distributorGenerated.removeFiles(imagePaths, 1).then(() => {
                            this.log.info("Removed " + imagePaths.length + " generated images on all distribute servers!");
                            return res();
                        }).catch((e) => {
                            // catch error, ignore failure
                            this.log.debug("Removing generated files on server failed: " + imagePaths.join(" , "));
                            return res();
                        });
                    });
                })());
            }

            return Promise.all(tasks).then(() => {
                return resolve();
            }).catch((e) => {
                return reject(e);
            });
        });
    }
};