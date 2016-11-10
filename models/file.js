"use strict";

// @IMPORTS
var fs = require("fs");
var Application = require("neat-base").Application;
var Module = require("neat-base").Module;
var Tools = require("neat-base").Tools;
var mongoose = Application.modules.database.mongoose;
var _ = require("underscore");

var schema = new mongoose.Schema({

    name: {
        type: "string",
        required: true
    },

    mimetype: {
        type: "String",
        required: true
    },

    originalname: {
        type: "String",
        required: true
    },

    extension: {
        type: "String",
        required: true
    },

    type: {
        type: "String",
        required: true,
        enum: [
            "image",
            "misc"
        ],
        default: "misc"
    }

}, {
    toJSON: {
        virtuals: true
    },
    toObject: {
        virtuals: true
    }
});

schema.virtual("filename").get(function () {
    return this._id + "." + this.extension;
})

schema.virtual("filepath").get(function () {
    return Application.modules.file.config.fileDir + "/" + this.filename;
})

schema.virtual("fileurl").get(function () {
    if (this.type === "image" && Application.modules.imageserver) {
        return Application.modules.imageserver.getUrls(this);
    } else {
        return Application.modules.file.config.fileDir + "/" + this.filename;
    }
})

schema.pre("remove", function (next) {
    var fullFilePath = Application.config.rootPath + this.filepath;
    var pgkPaths = _.values(Application.modules.imageserver.getPaths(this));
    pgkPaths.push(fullFilePath);

    for (var i = 0; i < pgkPaths.length; i++) {
        var file = pgkPaths[i];
        try {
            fs.accessSync(file, fs.R_OK);
            fs.unlink(file);
        } catch (e) {
        }
    }

    next();
})

module.exports = schema;