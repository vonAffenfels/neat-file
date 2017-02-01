"use strict";

// @IMPORTS
const fs = require("fs");
const Application = require("neat-base").Application;
const Module = require("neat-base").Module;
const Tools = require("neat-base").Tools;
const mongoose = Application.modules.database.mongoose;
const _ = require("underscore");

let schema = new mongoose.Schema({

    name: {
        type: "string",
        required: true
    },

    mimetype: {
        type: "String",
        required: true
    },

    filesize: {
        type: "Number",
        required: false,
        default: 0
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
    permissions: {
        find: true,
        findOne: true,
        count: true,
        schema: true,
        save: "own",
        remove: "own"
    },
    toJSON: {
        virtuals: true
    },
    toObject: {
        virtuals: true
    }
});

module.exports = schema;