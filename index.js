"use strict";

// @IMPORTS
var Application = require("neat-base").Application;
var Module = require("neat-base").Module;
var Tools = require("neat-base").Tools;
var multer = require('multer');
var mkdirp = require('mkdirp');
var fs = require('fs');

var mime = require("mime");
var request = require('request');
var crypto = require("crypto");
var Promise = require("bluebird");

module.exports = class Files extends Module {

    static defaultConfig() {
        return {
            uploadDir: "/data/uploads",
            fileDir: "/data/files",
            dbModuleName: "database",
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
            var uploader = multer({
                dest: this.uploadTarget,
                limits: {
                    fileSize: this.config.limits.fileSize * 1024 * 1024
                }
            });

            // create any missing directories (sync because its startup after all)
            mkdirp.sync(this.uploadTarget);
            mkdirp.sync(this.fileDir);


            /*
             Routes
             */
            if (Application.modules[this.config.webserverModuleName]) {
                // upload a single file
                Application.modules[this.config.webserverModuleName].addRoute("post", "/upload", uploader.single('file'), (req, res) => {
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
            try {
                var model = Application.modules[this.config.dbModuleName].getModel("file");
                var newFile = new model({
                    name: properties.name || uploadedFileObj.originalname,
                    originalname: uploadedFileObj.originalname,
                    type: this.getTypeFromMimeType(uploadedFileObj.mimetype),
                    mimetype: uploadedFileObj.mimetype,
                    extension: "jpeg"
                });
            } catch (e) {
                console.error(e);
                return reject(e);
            }

            newFile.save().then(() => {
                fs.rename(uploadedFileObj.path, this.fileDir + "/" + newFile.filename, (err) => {
                    if (err) {
                        fs.unlink('./' + uploadedFileObj.path);
                        return reject(err);
                    }

                    resolve(newFile);
                });
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
     * @param name
     * @param schema
     */
    modifySchema(name, schema) {
        if (name === "file") {
            schema.virtual("filename").get(function () {
                return this._id + "." + this.extension;
            });

            schema.virtual("filepath").get(function () {
                return Application.modules.file.config.fileDir + "/" + this.filename;
            });

            schema.pre("remove", function (next) {
                var fullFilePath = Application.config.rootPath + this.filepath;
                fs.unlink(fullFilePath);
                next();
            });
        }
    }
}