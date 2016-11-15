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

module.exports = schema;