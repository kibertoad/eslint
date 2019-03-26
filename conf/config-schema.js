/**
 * @fileoverview Defines a schema for configs.
 * @author Sylvan Mably
 */

"use strict";

const baseConfigProperties = {
    env: { type: "object" },
    extends: { $ref: "#/definitions/stringOrStrings" },
    globals: { type: "object" },
    overrides: {
        type: "array",
        items: { $ref: "#/definitions/overrideConfig" },
        additionalItems: false
    },
    parser: { type: ["string", "null"] },
    parserOptions: { type: "object" },
    plugins: { type: "array" },
    rules: { type: "object" },
    settings: { type: "object" },

    ecmaFeatures: { type: "object" } // deprecated; logs a warning when used
};

const configSchema = {
    definitions: {
        stringOrStrings: {
            oneOf: [
                { type: "string" },
                {
                    type: "array",
                    items: { type: "string" }
                }
            ]
        },
        stringOrStringsRequired: {
            oneOf: [
                { type: "string" },
                {
                    type: "array",
                    items: { type: "string" },
                    minItems: 1
                }
            ]
        },

        // Config at top-level.
        objectConfig: {
            type: "object",
            properties: Object.assign(
                {
                    root: { type: "boolean" }
                },
                baseConfigProperties
            ),
            additionalProperties: false
        },

        // Config in `overrides`.
        overrideConfig: {
            type: "object",
            properties: Object.assign(
                {
                    excludedFiles: { $ref: "#/definitions/stringOrStrings" },
                    files: { $ref: "#/definitions/stringOrStringsRequired" }
                },
                baseConfigProperties
            ),
            required: ["files"],
            additionalProperties: false
        }
    },

    $ref: "#/definitions/objectConfig"
};

module.exports = configSchema;
