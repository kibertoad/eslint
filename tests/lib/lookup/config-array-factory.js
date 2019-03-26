/**
 * @fileoverview Tests for ConfigArrayFactory class.
 * @author Toru Nagashima <https://github.com/mysticatea>
 */
"use strict";

const os = require("os");
const path = require("path");
const { assert } = require("chai");
const { spy } = require("sinon");
const { ConfigArray } = require("../../../lib/lookup/config-array");
const { OverrideTester } = require("../../../lib/lookup/override-tester");
const { defineConfigArrayFactoryWithInmemoryFileSystem } = require("./_utils");

const tempDir = path.join(os.tmpdir(), "eslint/config-array-factory");

// For VSCode intellisense.
/** @typedef {InstanceType<ReturnType<defineConfigArrayFactoryWithInmemoryFileSystem>["ConfigArrayFactory"]>} ConfigArrayFactory */

/**
 * Assert a config array element.
 * @param {Object} actual The actual value.
 * @param {Object} providedExpected The expected value.
 * @returns {void}
 */
function assertConfigArrayElement(actual, providedExpected) {
    const expected = {
        name: "",
        filePath: "",
        criteria: null,
        env: void 0,
        globals: void 0,
        parser: void 0,
        parserOptions: void 0,
        plugins: void 0,
        processor: void 0,
        root: void 0,
        rules: void 0,
        settings: void 0,
        ...providedExpected
    };

    assert.deepStrictEqual(actual, expected);
}

/**
 * Assert a config array element.
 * @param {Object} actual The actual value.
 * @param {Object} providedExpected The expected value.
 * @returns {void}
 */
function assertConfig(actual, providedExpected) {
    const expected = {
        env: {},
        globals: {},
        parser: null,
        parserOptions: {},
        plugins: [],
        rules: {},
        settings: {},
        ...providedExpected
    };

    assert.deepStrictEqual(actual, expected);
}

describe("ConfigArrayFactory", () => {
    describe("'create(configData, options)' method should normalize the config data.", () => {
        const { ConfigArrayFactory } = defineConfigArrayFactoryWithInmemoryFileSystem({
            cwd: () => tempDir
        });
        const factory = new ConfigArrayFactory();

        it("should return an empty config array if 'configData' is null.", () => {
            assert.strictEqual(factory.create(null).length, 0);
        });

        it("should throw an error if the config data had invalid properties,", () => {
            assert.throws(() => {
                factory.create({ files: true });
            }, /Unexpected top-level property "files"/u);
        });

        it("should call '_normalizeConfigData(configData, options)' with given arguments except 'options.parent'.", () => {
            const configData = {};
            const filePath = __filename;
            const name = "example";
            const parent = new ConfigArray();
            const normalizeConfigData = spy(factory, "_normalizeConfigData");

            factory.create(configData, { filePath, name, parent });

            assert.strictEqual(normalizeConfigData.callCount, 1);
            assert.strictEqual(normalizeConfigData.args[0].length, 3);
            assert.strictEqual(normalizeConfigData.args[0][0], configData);
            assert.strictEqual(normalizeConfigData.args[0][1], filePath);
            assert.strictEqual(normalizeConfigData.args[0][2], name);
        });

        it("should return a config array that contains the yielded elements from '_normalizeConfigData(configData, options)'.", () => {
            const elements = [{}, {}];

            factory._normalizeConfigData = () => elements; // eslint-disable-line no-underscore-dangle

            const configArray = factory.create({});

            assert.strictEqual(configArray.length, 2);
            assert.strictEqual(configArray[0], elements[0]);
            assert.strictEqual(configArray[1], elements[1]);
        });

        it("should concatenate the elements of `options.parent` and the yielded elements from '_normalizeConfigData(configData, options)'.", () => {
            const parent = new ConfigArray({}, {});
            const elements = [{}, {}];

            factory._normalizeConfigData = () => elements; // eslint-disable-line no-underscore-dangle

            const configArray = factory.create({}, { parent });

            assert.strictEqual(configArray.length, 4);
            assert.strictEqual(configArray[0], parent[0]);
            assert.strictEqual(configArray[1], parent[1]);
            assert.strictEqual(configArray[2], elements[0]);
            assert.strictEqual(configArray[3], elements[1]);
        });

        it("should not concatenate the elements of `options.parent` if the yielded elements from '_normalizeConfigData(configData, options)' has 'root:true'.", () => {
            const parent = new ConfigArray({}, {});
            const elements = [{ root: true }, {}];

            factory._normalizeConfigData = () => elements; // eslint-disable-line no-underscore-dangle

            const configArray = factory.create({}, { parent });

            assert.strictEqual(configArray.length, 2);
            assert.strictEqual(configArray[0], elements[0]);
            assert.strictEqual(configArray[1], elements[1]);
        });
    });

    describe("'loadFile(filePath, options)' method should load a config file.", () => {
        const basicFiles = {
            "js/.eslintrc.js": "exports.settings = { name: 'js/.eslintrc.js' }",
            "json/.eslintrc.json": "{ \"settings\": { \"name\": \"json/.eslintrc.json\" } }",
            "legacy-json/.eslintrc": "{ \"settings\": { \"name\": \"legacy-json/.eslintrc\" } }",
            "legacy-yml/.eslintrc": "settings:\n  name: legacy-yml/.eslintrc",
            "package-json/package.json": "{ \"eslintConfig\": { \"settings\": { \"name\": \"package-json/package.json\" } } }",
            "yml/.eslintrc.yml": "settings:\n  name: yml/.eslintrc.yml",
            "yaml/.eslintrc.yaml": "settings:\n  name: yaml/.eslintrc.yaml"
        };
        const { ConfigArrayFactory } = defineConfigArrayFactoryWithInmemoryFileSystem({
            cwd: () => tempDir,
            files: {
                ...basicFiles,
                "invalid-property.json": "{ \"files\": \"*.js\" }",
                "package-json-no-config/package.json": "{ \"name\": \"foo\" }"
            }
        });
        const factory = new ConfigArrayFactory();

        it("should throw an error if 'filePath' is null.", () => {
            assert.throws(() => factory.loadFile(null));
        });

        it("should throw an error if 'filePath' doesn't exist.", () => {
            assert.throws(() => {
                factory.loadFile("non-exist");
            }, /Cannot read config file:.*non-exist/su);
        });

        it("should throw an error if 'filePath' was 'package.json' and it doesn't have 'eslintConfig' field.", () => {
            assert.throws(() => {
                factory.loadFile("package-json-no-config/package.json");
            }, /Cannot read config file:.*package.json/su);
        });

        it("should throw an error if the config data had invalid properties,", () => {
            assert.throws(() => {
                factory.loadFile("invalid-property.json");
            }, /Unexpected top-level property "files"/u);
        });

        for (const filePath of Object.keys(basicFiles)) {
            it(`should load '${filePath}' then return a config array what contains that file content.`, () => {
                const configArray = factory.loadFile(filePath);

                assert.strictEqual(configArray.length, 1);
                assertConfigArrayElement(configArray[0], {
                    filePath: path.resolve(tempDir, filePath),
                    name: path.relative(tempDir, path.resolve(tempDir, filePath)),
                    settings: { name: filePath }
                });
            });
        }

        it("should call '_normalizeConfigData(configData, options)' with the loaded config data and given options except 'options.parent'.", () => {
            const filePath = "js/.eslintrc.js";
            const name = "example";
            const parent = new ConfigArray();
            const normalizeConfigData = spy(factory, "_normalizeConfigData");

            factory.loadFile(filePath, { name, parent });

            assert.strictEqual(normalizeConfigData.callCount, 1);
            assert.strictEqual(normalizeConfigData.args[0].length, 3);
            assert.deepStrictEqual(normalizeConfigData.args[0][0], { settings: { name: filePath } });
            assert.strictEqual(normalizeConfigData.args[0][1], path.resolve(tempDir, filePath));
            assert.strictEqual(normalizeConfigData.args[0][2], name);
        });

        it("should return a config array that contains the yielded elements from '_normalizeConfigData(configData, options)'.", () => {
            const elements = [{}, {}];

            factory._normalizeConfigData = () => elements; // eslint-disable-line no-underscore-dangle

            const configArray = factory.loadFile("js/.eslintrc.js");

            assert.strictEqual(configArray.length, 2);
            assert.strictEqual(configArray[0], elements[0]);
            assert.strictEqual(configArray[1], elements[1]);
        });

        it("should concatenate the elements of `options.parent` and the yielded elements from '_normalizeConfigData(configData, options)'.", () => {
            const parent = new ConfigArray({}, {});
            const elements = [{}, {}];

            factory._normalizeConfigData = () => elements; // eslint-disable-line no-underscore-dangle

            const configArray = factory.loadFile("js/.eslintrc.js", { parent });

            assert.strictEqual(configArray.length, 4);
            assert.strictEqual(configArray[0], parent[0]);
            assert.strictEqual(configArray[1], parent[1]);
            assert.strictEqual(configArray[2], elements[0]);
            assert.strictEqual(configArray[3], elements[1]);
        });

        it("should not concatenate the elements of `options.parent` if the yielded elements from '_normalizeConfigData(configData, options)' has 'root:true'.", () => {
            const parent = new ConfigArray({}, {});
            const elements = [{ root: true }, {}];

            factory._normalizeConfigData = () => elements; // eslint-disable-line no-underscore-dangle

            const configArray = factory.loadFile("js/.eslintrc.js", { parent });

            assert.strictEqual(configArray.length, 2);
            assert.strictEqual(configArray[0], elements[0]);
            assert.strictEqual(configArray[1], elements[1]);
        });
    });

    describe("'loadOnDirectory(directoryPath, options)' method should load the config file of a directory.", () => {
        const basicFiles = {
            "js/.eslintrc.js": "exports.settings = { name: 'js/.eslintrc.js' }",
            "json/.eslintrc.json": "{ \"settings\": { \"name\": \"json/.eslintrc.json\" } }",
            "legacy-json/.eslintrc": "{ \"settings\": { \"name\": \"legacy-json/.eslintrc\" } }",
            "legacy-yml/.eslintrc": "settings:\n  name: legacy-yml/.eslintrc",
            "package-json/package.json": "{ \"eslintConfig\": { \"settings\": { \"name\": \"package-json/package.json\" } } }",
            "yml/.eslintrc.yml": "settings:\n  name: yml/.eslintrc.yml",
            "yaml/.eslintrc.yaml": "settings:\n  name: yaml/.eslintrc.yaml"
        };
        const { ConfigArrayFactory } = defineConfigArrayFactoryWithInmemoryFileSystem({
            cwd: () => tempDir,
            files: {
                ...basicFiles,
                "invalid-property/.eslintrc.json": "{ \"files\": \"*.js\" }",
                "package-json-no-config/package.json": "{ \"name\": \"foo\" }"
            }
        });
        const factory = new ConfigArrayFactory();

        it("should throw an error if 'directoryPath' is null.", () => {
            assert.throws(() => factory.loadOnDirectory(null));
        });

        it("should return an empty config array if the config file of 'directoryPath' doesn't exist.", () => {
            assert.strictEqual(factory.loadOnDirectory("non-exist").length, 0);
        });

        it("should return an empty config array if the config file of 'directoryPath' was package.json and it didn't have 'eslintConfig' field.", () => {
            assert.strictEqual(factory.loadOnDirectory("package-json-no-config").length, 0);
        });

        it("should throw an error if the config data had invalid properties,", () => {
            assert.throws(() => {
                factory.loadOnDirectory("invalid-property");
            }, /Unexpected top-level property "files"/u);
        });

        for (const filePath of Object.keys(basicFiles)) {
            const directoryPath = filePath.split("/")[0];

            it(`should load '${directoryPath}' then return a config array what contains the config file of that directory.`, () => {
                const configArray = factory.loadOnDirectory(directoryPath);

                assert.strictEqual(configArray.length, 1);
                assertConfigArrayElement(configArray[0], {
                    filePath: path.resolve(tempDir, filePath),
                    name: path.relative(tempDir, path.resolve(tempDir, filePath)),
                    settings: { name: filePath }
                });
            });
        }

        it("should call '_normalizeConfigData(configData, options)' with the loaded config data and given options except 'options.parent'.", () => {
            const directoryPath = "js";
            const name = "example";
            const parent = new ConfigArray();
            const normalizeConfigData = spy(factory, "_normalizeConfigData");

            factory.loadOnDirectory(directoryPath, { name, parent });

            assert.strictEqual(normalizeConfigData.callCount, 1);
            assert.strictEqual(normalizeConfigData.args[0].length, 3);
            assert.deepStrictEqual(normalizeConfigData.args[0][0], { settings: { name: `${directoryPath}/.eslintrc.js` } });
            assert.strictEqual(normalizeConfigData.args[0][1], path.resolve(tempDir, directoryPath, ".eslintrc.js"));
            assert.strictEqual(normalizeConfigData.args[0][2], name);
        });

        it("should return a config array that contains the yielded elements from '_normalizeConfigData(configData, options)'.", () => {
            const elements = [{}, {}];

            factory._normalizeConfigData = () => elements; // eslint-disable-line no-underscore-dangle

            const configArray = factory.loadOnDirectory("js");

            assert.strictEqual(configArray.length, 2);
            assert.strictEqual(configArray[0], elements[0]);
            assert.strictEqual(configArray[1], elements[1]);
        });

        it("should concatenate the elements of `options.parent` and the yielded elements from '_normalizeConfigData(configData, options)'.", () => {
            const parent = new ConfigArray({}, {});
            const elements = [{}, {}];

            factory._normalizeConfigData = () => elements; // eslint-disable-line no-underscore-dangle

            const configArray = factory.loadOnDirectory("js", { parent });

            assert.strictEqual(configArray.length, 4);
            assert.strictEqual(configArray[0], parent[0]);
            assert.strictEqual(configArray[1], parent[1]);
            assert.strictEqual(configArray[2], elements[0]);
            assert.strictEqual(configArray[3], elements[1]);
        });

        it("should not concatenate the elements of `options.parent` if the yielded elements from '_normalizeConfigData(configData, options)' has 'root:true'.", () => {
            const parent = new ConfigArray({}, {});
            const elements = [{ root: true }, {}];

            factory._normalizeConfigData = () => elements; // eslint-disable-line no-underscore-dangle

            const configArray = factory.loadOnDirectory("js", { parent });

            assert.strictEqual(configArray.length, 2);
            assert.strictEqual(configArray[0], elements[0]);
            assert.strictEqual(configArray[1], elements[1]);
        });
    });

    /*
     * All of `create`, `loadFile`, and `loadOnDirectory` call this method.
     * So this section tests the common part of the three.
     */
    describe("'_normalizeConfigData(configData, options)' method should normalize the config data.", () => {

        /** @type {ConfigArrayFactory} */
        let factory = null;

        /**
         * Call `_normalizeConfigData` method with given arguments.
         * @param {ConfigData} configData The config data to normalize.
         * @param {Object} [options] The options.
         * @param {string} [options.filePath] The path to the config file of the config data.
         * @param {string} [options.name] The name of the config file of the config data.
         * @returns {ConfigArray} The created config array.
         */
        function create(configData, { filePath, name } = {}) {
            return new ConfigArray(...factory._normalizeConfigData(configData, filePath, name)); // eslint-disable-line no-underscore-dangle
        }

        describe("misc", () => {
            before(() => {
                const { ConfigArrayFactory } = defineConfigArrayFactoryWithInmemoryFileSystem({
                    cwd: () => tempDir
                });

                factory = new ConfigArrayFactory();
            });

            describe("if the config data was empty, the returned value", () => {
                let configArray;

                beforeEach(() => {
                    configArray = create({});
                });

                it("should have an element.", () => {
                    assert.strictEqual(configArray.length, 1);
                });

                it("should have the default values in the element.", () => {
                    assertConfigArrayElement(configArray[0], {});
                });
            });

            describe("if the config data had 'env' property, the returned value", () => {
                const env = { node: true };
                let configArray;

                beforeEach(() => {
                    configArray = create({ env });
                });

                it("should have an element.", () => {
                    assert.strictEqual(configArray.length, 1);
                });

                it("should have the 'env' value in the element.", () => {
                    assertConfigArrayElement(configArray[0], { env });
                });
            });

            describe("if the config data had 'globals' property, the returned value", () => {
                const globals = { window: "readonly" };
                let configArray;

                beforeEach(() => {
                    configArray = create({ globals });
                });

                it("should have an element.", () => {
                    assert.strictEqual(configArray.length, 1);
                });

                it("should have the 'globals' value in the element.", () => {
                    assertConfigArrayElement(configArray[0], { globals });
                });
            });

            describe("if the config data had 'parser' property, the returned value", () => {
                const parser = "espree";
                let configArray;

                beforeEach(() => {
                    configArray = create({ parser });
                });

                it("should have an element.", () => {
                    assert.strictEqual(configArray.length, 1);
                });

                it("should have the 'parser' value in the element.", () => {
                    assert.strictEqual(configArray[0].parser.id, parser);
                });
            });

            describe("if the config data had 'parserOptions' property, the returned value", () => {
                const parserOptions = { ecmaVersion: 2015 };
                let configArray;

                beforeEach(() => {
                    configArray = create({ parserOptions });
                });

                it("should have an element.", () => {
                    assert.strictEqual(configArray.length, 1);
                });

                it("should have the 'parserOptions' value in the element.", () => {
                    assertConfigArrayElement(configArray[0], { parserOptions });
                });
            });

            describe("if the config data had 'plugins' property, the returned value", () => {
                const plugins = [];
                let configArray;

                beforeEach(() => {
                    configArray = create({ plugins });
                });

                it("should have an element.", () => {
                    assert.strictEqual(configArray.length, 1);
                });

                it("should have the 'plugins' value in the element.", () => {
                    assertConfigArrayElement(configArray[0], { plugins: {} });
                });
            });

            describe("if the config data had 'root' property, the returned value", () => {
                const root = true;
                let configArray;

                beforeEach(() => {
                    configArray = create({ root });
                });

                it("should have an element.", () => {
                    assert.strictEqual(configArray.length, 1);
                });

                it("should have the 'root' value in the element.", () => {
                    assertConfigArrayElement(configArray[0], { root });
                });
            });

            describe("if the config data had 'rules' property, the returned value", () => {
                const rules = { eqeqeq: "error" };
                let configArray;

                beforeEach(() => {
                    configArray = create({ rules });
                });

                it("should have an element.", () => {
                    assert.strictEqual(configArray.length, 1);
                });

                it("should have the 'rules' value in the element.", () => {
                    assertConfigArrayElement(configArray[0], { rules });
                });
            });

            describe("if the config data had 'settings' property, the returned value", () => {
                const settings = { foo: 777 };
                let configArray;

                beforeEach(() => {
                    configArray = create({ settings });
                });

                it("should have an element.", () => {
                    assert.strictEqual(configArray.length, 1);
                });

                it("should have the 'settings' value in the element.", () => {
                    assertConfigArrayElement(configArray[0], { settings });
                });
            });
        });

        describe("'parser' details", () => {
            before(() => {
                const { ConfigArrayFactory } = defineConfigArrayFactoryWithInmemoryFileSystem({
                    cwd: () => tempDir,
                    files: {
                        "node_modules/xxx-parser/index.js": "exports.name = 'xxx-parser';",
                        "subdir/node_modules/xxx-parser/index.js": "exports.name = 'subdir/xxx-parser';",
                        "parser.js": "exports.name = './parser.js';"
                    }
                });

                factory = new ConfigArrayFactory();
            });

            describe("if the 'parser' property was a valid package, the first config array element", () => {
                let element;

                beforeEach(() => {
                    element = create({ parser: "xxx-parser" })[0];
                });

                it("should have the package ID at 'parser.id' property.", () => {
                    assert.strictEqual(element.parser.id, "xxx-parser");
                });

                it("should have the package object at 'parser.definition' property.", () => {
                    assert.deepStrictEqual(element.parser.definition, { name: "xxx-parser" });
                });

                it("should have the path to the package at 'parser.filePath' property.", () => {
                    assert.strictEqual(element.parser.filePath, path.join(tempDir, "node_modules/xxx-parser/index.js"));
                });
            });

            describe("if the 'parser' property was an invalid package, the first config array element", () => {
                let element;

                beforeEach(() => {
                    element = create({ parser: "invalid-parser" })[0];
                });

                it("should have the package ID at 'parser.id' property.", () => {
                    assert.strictEqual(element.parser.id, "invalid-parser");
                });

                it("should have the loading error at 'parser.error' property.", () => {
                    assert.match(element.parser.error.message, /Cannot find module 'invalid-parser'/u);
                });
            });

            describe("if the 'parser' property was a valid relative path, the first config array element", () => {
                let element;

                beforeEach(() => {
                    element = create({ parser: "./parser" })[0];
                });

                it("should have the given path at 'parser.id' property.", () => {
                    assert.strictEqual(element.parser.id, "./parser");
                });

                it("should have the file's object at 'parser.definition' property.", () => {
                    assert.deepStrictEqual(element.parser.definition, { name: "./parser.js" });
                });

                it("should have the absolute path to the file at 'parser.filePath' property.", () => {
                    assert.strictEqual(element.parser.filePath, path.join(tempDir, "./parser.js"));
                });
            });

            describe("if the 'parser' property was an invalid relative path, the first config array element", () => {
                let element;

                beforeEach(() => {
                    element = create({ parser: "./invalid-parser" })[0];
                });

                it("should have the given path at 'parser.id' property.", () => {
                    assert.strictEqual(element.parser.id, "./invalid-parser");
                });

                it("should have the loading error at 'parser.error' property.", () => {
                    assert.match(element.parser.error.message, /Cannot find module '.\/invalid-parser'/u);
                });
            });

            describe("if 'parser' property was given and 'filePath' option was given, the parser", () => {
                let element;

                beforeEach(() => {
                    element = create(
                        { parser: "xxx-parser" },
                        { filePath: path.join(tempDir, "subdir/.eslintrc") }
                    )[0];
                });

                it("should be resolved relative to the 'filePath' option.", () => {
                    assert.strictEqual(
                        element.parser.filePath,

                        // rather than "xxx-parser" at the project root.
                        path.join(tempDir, "subdir/node_modules/xxx-parser/index.js")
                    );
                });
            });
        });

        describe("'plugins' details", () => {
            before(() => {
                const { ConfigArrayFactory } = defineConfigArrayFactoryWithInmemoryFileSystem({
                    cwd: () => tempDir,
                    files: {
                        "node_modules/eslint-plugin-ext/index.js": "exports.processors = { '.abc': {}, '.xyz': {}, other: {} };",
                        "node_modules/eslint-plugin-subdir/index.js": "",
                        "node_modules/eslint-plugin-xxx/index.js": "exports.name = 'eslint-plugin-xxx';",
                        "subdir/node_modules/eslint-plugin-subdir/index.js": "",
                        "parser.js": ""
                    }
                });

                factory = new ConfigArrayFactory();
            });

            it("should throw an error if a 'plugins' value is a file path.", () => {
                assert.throws(() => {
                    create({ plugins: ["./path/to/plugin"] });
                }, /Plugins array cannot includes file paths/u);
            });

            describe("if the 'plugins' property was a valid package, the first config array element", () => {
                let element;

                beforeEach(() => {
                    element = create({ plugins: ["xxx"] })[0];
                });

                it("should have 'plugins[id]' property.", () => {
                    assert.notStrictEqual(element.plugins.xxx, void 0);
                });

                it("should have the package ID at 'plugins[id].id' property.", () => {
                    assert.strictEqual(element.plugins.xxx.id, "xxx");
                });

                it("should have the package object at 'plugins[id].definition' property.", () => {
                    assert.deepStrictEqual(element.plugins.xxx.definition, { name: "eslint-plugin-xxx" });
                });

                it("should have the path to the package at 'plugins[id].filePath' property.", () => {
                    assert.strictEqual(element.plugins.xxx.filePath, path.join(tempDir, "node_modules/eslint-plugin-xxx/index.js"));
                });
            });

            describe("if the 'plugins' property was an invalid package, the first config array element", () => {
                let element;

                beforeEach(() => {
                    element = create({ plugins: ["invalid"] })[0];
                });

                it("should have 'plugins[id]' property.", () => {
                    assert.notStrictEqual(element.plugins.invalid, void 0);
                });

                it("should have the package ID at 'plugins[id].id' property.", () => {
                    assert.strictEqual(element.plugins.invalid.id, "invalid");
                });

                it("should have the loading error at 'plugins[id].error' property.", () => {
                    assert.match(element.plugins.invalid.error.message, /Cannot find module 'eslint-plugin-invalid'/u);
                });
            });

            describe("even if 'plugins' property was given and 'filePath' option was given,", () => {
                it("should load the plugin from the project root.", () => {
                    const configArray = create(
                        { plugins: ["subdir"] },
                        { filePath: path.resolve(tempDir, "subdir/a.js") }
                    );

                    assert.strictEqual(
                        configArray[0].plugins.subdir.filePath,

                        // "subdir/node_modules/eslint-plugin-subdir/index.js" exists, but not it.
                        path.resolve(tempDir, "node_modules/eslint-plugin-subdir/index.js")
                    );
                });
            });

            describe("if 'plugins' property was given and the plugin has two file extension processors, the returned value", () => {
                let configArray;

                beforeEach(() => {
                    configArray = create({ plugins: ["ext"] });
                });

                it("should have three elements.", () => {
                    assert.strictEqual(configArray.length, 3);
                });

                describe("the first element", () => {
                    let element;

                    beforeEach(() => {
                        element = configArray[0];
                    });

                    it("should be named '#processors[\"ext/.abc\"]'.", () => {
                        assert.strictEqual(element.name, "#processors[\"ext/.abc\"]");
                    });

                    it("should not have 'plugins' property.", () => {
                        assert.strictEqual(element.plugins, void 0);
                    });

                    it("should have 'processor' property.", () => {
                        assert.strictEqual(element.processor, "ext/.abc");
                    });

                    it("should have 'criteria' property what matches '.abc'.", () => {
                        assert.strictEqual(element.criteria.test(path.join(tempDir, "1234.abc")), true);
                        assert.strictEqual(element.criteria.test(path.join(tempDir, "1234.xyz")), false);
                    });
                });

                describe("the secand element", () => {
                    let element;

                    beforeEach(() => {
                        element = configArray[1];
                    });

                    it("should be named '#processors[\"ext/.xyz\"]'.", () => {
                        assert.strictEqual(element.name, "#processors[\"ext/.xyz\"]");
                    });

                    it("should not have 'plugins' property.", () => {
                        assert.strictEqual(element.plugins, void 0);
                    });

                    it("should have 'processor' property.", () => {
                        assert.strictEqual(element.processor, "ext/.xyz");
                    });

                    it("should have 'criteria' property what matches '.xyz'.", () => {
                        assert.strictEqual(element.criteria.test(path.join(tempDir, "1234.abc")), false);
                        assert.strictEqual(element.criteria.test(path.join(tempDir, "1234.xyz")), true);
                    });
                });

                describe("the third element", () => {
                    let element;

                    beforeEach(() => {
                        element = configArray[2];
                    });

                    it("should have 'plugins' property.", () => {
                        assert.strictEqual(element.plugins.ext.id, "ext");
                    });

                    it("should not have 'processor' property.", () => {
                        assert.strictEqual(element.processor, void 0);
                    });
                });
            });
        });

        describe("'extends' details", () => {
            before(() => {
                const { ConfigArrayFactory } = defineConfigArrayFactoryWithInmemoryFileSystem({
                    cwd: () => tempDir,
                    files: {
                        "node_modules/eslint-config-foo/index.js": "exports.env = { browser: true }",
                        "node_modules/eslint-config-one/index.js": "module.exports = { extends: 'two', env: { browser: true } }",
                        "node_modules/eslint-config-two/index.js": "module.exports = { env: { node: true } }",
                        "node_modules/eslint-config-override/index.js": `
                            module.exports = {
                                rules: { regular: 1 },
                                overrides: [
                                    { files: '*.xxx', rules: { override: 1 } },
                                    { files: '*.yyy', rules: { override: 2 } }
                                ]
                            }
                        `,
                        "node_modules/eslint-plugin-foo/index.js": "exports.configs = { bar: { env: { es6: true } } }",
                        "node_modules/eslint-plugin-invalid-config/index.js": "exports.configs = { foo: {} }",
                        "node_modules/eslint-plugin-error/index.js": "throw new Error('xxx error')",
                        "base.js": "module.exports = { rules: { semi: [2, 'always'] } };"
                    }
                });

                factory = new ConfigArrayFactory();
            });

            it("should throw an error when extends config module is not found", () => {
                assert.throws(() => {
                    create({
                        extends: "not-exist",
                        rules: { eqeqeq: 2 }
                    });
                }, /Failed to load config "not-exist" to extend from./u);
            });

            it("should throw an error when an eslint config is not found", () => {
                assert.throws(() => {
                    create({
                        extends: "eslint:foo",
                        rules: { eqeqeq: 2 }
                    });
                }, /Failed to load config "eslint:foo" to extend from./u);
            });

            it("should throw an error when a plugin threw while loading.", () => {
                assert.throws(() => {
                    create({
                        extends: "plugin:error/foo",
                        rules: { eqeqeq: 2 }
                    });
                }, /xxx error/u);
            });

            it("should throw an error when a plugin extend is a file path.", () => {
                assert.throws(() => {
                    create({
                        extends: "plugin:./path/to/foo",
                        rules: { eqeqeq: 2 }
                    });
                }, /'extends' cannot use a file path for plugins/u);
            });

            it("should throw an error when an eslint config is not found", () => {
                assert.throws(() => {
                    create({
                        extends: "eslint:foo",
                        rules: { eqeqeq: 2 }
                    });
                }, /Failed to load config "eslint:foo" to extend from./u);
            });

            describe("if 'extends' property was 'eslint:all', the returned value", () => {
                let configArray;

                beforeEach(() => {
                    configArray = create(
                        { extends: "eslint:all", rules: { eqeqeq: 1 } },
                        { name: ".eslintrc" }
                    );
                });

                it("should have two elements.", () => {
                    assert.strictEqual(configArray.length, 2);
                });

                it("should have the config data of 'eslint:all' at the first element.", () => {
                    assertConfigArrayElement(configArray[0], {
                        name: ".eslintrc » eslint:all",
                        filePath: require.resolve("../../../conf/eslint-all.js"),
                        ...require("../../../conf/eslint-all.js")
                    });
                });

                it("should have the given config data at the second element.", () => {
                    assertConfigArrayElement(configArray[1], {
                        name: ".eslintrc",
                        rules: { eqeqeq: 1 }
                    });
                });
            });

            describe("if 'extends' property was 'eslint:recommended', the returned value", () => {
                let configArray;

                beforeEach(() => {
                    configArray = create(
                        { extends: "eslint:recommended", rules: { eqeqeq: 1 } },
                        { name: ".eslintrc" }
                    );
                });

                it("should have two elements.", () => {
                    assert.strictEqual(configArray.length, 2);
                });

                it("should have the config data of 'eslint:recommended' at the first element.", () => {
                    assertConfigArrayElement(configArray[0], {
                        name: ".eslintrc » eslint:recommended",
                        filePath: require.resolve("../../../conf/eslint-recommended.js"),
                        ...require("../../../conf/eslint-recommended.js")
                    });
                });

                it("should have the given config data at the second element.", () => {
                    assertConfigArrayElement(configArray[1], {
                        name: ".eslintrc",
                        rules: { eqeqeq: 1 }
                    });
                });
            });

            describe("if 'extends' property was 'foo', the returned value", () => {
                let configArray;

                beforeEach(() => {
                    configArray = create(
                        { extends: "foo", rules: { eqeqeq: 1 } },
                        { name: ".eslintrc" }
                    );
                });

                it("should have two elements.", () => {
                    assert.strictEqual(configArray.length, 2);
                });

                it("should have the config data of 'eslint-config-foo' at the first element.", () => {
                    assertConfigArrayElement(configArray[0], {
                        name: ".eslintrc » eslint-config-foo",
                        filePath: path.join(tempDir, "node_modules/eslint-config-foo/index.js"),
                        env: { browser: true }
                    });
                });

                it("should have the given config data at the second element.", () => {
                    assertConfigArrayElement(configArray[1], {
                        name: ".eslintrc",
                        rules: { eqeqeq: 1 }
                    });
                });
            });

            describe("if 'extends' property was 'plugin:foo/bar', the returned value", () => {
                let configArray;

                beforeEach(() => {
                    configArray = create(
                        { extends: "plugin:foo/bar", rules: { eqeqeq: 1 } },
                        { name: ".eslintrc" }
                    );
                });

                it("should have two elements.", () => {
                    assert.strictEqual(configArray.length, 2);
                });

                it("should have the config data of 'plugin:foo/bar' at the first element.", () => {
                    assertConfigArrayElement(configArray[0], {
                        name: ".eslintrc » plugin:foo/bar",
                        filePath: path.join(tempDir, "node_modules/eslint-plugin-foo/index.js"),
                        env: { es6: true }
                    });
                });

                it("should have the given config data at the second element.", () => {
                    assertConfigArrayElement(configArray[1], {
                        name: ".eslintrc",
                        rules: { eqeqeq: 1 }
                    });
                });
            });

            describe("if 'extends' property was './base', the returned value", () => {
                let configArray;

                beforeEach(() => {
                    configArray = create(
                        { extends: "./base", rules: { eqeqeq: 1 } },
                        { name: ".eslintrc" }
                    );
                });

                it("should have two elements.", () => {
                    assert.strictEqual(configArray.length, 2);
                });

                it("should have the config data of './base' at the first element.", () => {
                    assertConfigArrayElement(configArray[0], {
                        name: ".eslintrc » ./base",
                        filePath: path.join(tempDir, "base.js"),
                        rules: { semi: [2, "always"] }
                    });
                });

                it("should have the given config data at the second element.", () => {
                    assertConfigArrayElement(configArray[1], {
                        name: ".eslintrc",
                        rules: { eqeqeq: 1 }
                    });
                });
            });

            describe("if 'extends' property was 'one' and the 'one' extends 'two', the returned value", () => {
                let configArray;

                beforeEach(() => {
                    configArray = create(
                        { extends: "one", rules: { eqeqeq: 1 } },
                        { name: ".eslintrc" }
                    );
                });

                it("should have three elements.", () => {
                    assert.strictEqual(configArray.length, 3);
                });

                it("should have the config data of 'eslint-config-two' at the first element.", () => {
                    assertConfigArrayElement(configArray[0], {
                        name: ".eslintrc » eslint-config-one » eslint-config-two",
                        filePath: path.join(tempDir, "node_modules/eslint-config-two/index.js"),
                        env: { node: true }
                    });
                });

                it("should have the config data of 'eslint-config-one' at the second element.", () => {
                    assertConfigArrayElement(configArray[1], {
                        name: ".eslintrc » eslint-config-one",
                        filePath: path.join(tempDir, "node_modules/eslint-config-one/index.js"),
                        env: { browser: true }
                    });
                });

                it("should have the given config data at the thrid element.", () => {
                    assertConfigArrayElement(configArray[2], {
                        name: ".eslintrc",
                        rules: { eqeqeq: 1 }
                    });
                });
            });

            describe("if 'extends' property was 'override' and the 'override' has 'overrides' property, the returned value", () => {
                let configArray;

                beforeEach(() => {
                    configArray = create(
                        { extends: "override", rules: { eqeqeq: 1 } },
                        { name: ".eslintrc" }
                    );
                });

                it("should have four elements.", () => {
                    assert.strictEqual(configArray.length, 4);
                });

                it("should have the config data of 'eslint-config-override' at the first element.", () => {
                    assertConfigArrayElement(configArray[0], {
                        name: ".eslintrc » eslint-config-override",
                        filePath: path.join(tempDir, "node_modules/eslint-config-override/index.js"),
                        rules: { regular: 1 }
                    });
                });

                it("should have the 'overrides[0]' config data of 'eslint-config-override' at the second element.", () => {
                    assertConfigArrayElement(configArray[1], {
                        name: ".eslintrc » eslint-config-override#overrides[0]",
                        filePath: path.join(tempDir, "node_modules/eslint-config-override/index.js"),
                        criteria: OverrideTester.create(["*.xxx"], [], tempDir),
                        rules: { override: 1 }
                    });
                });

                it("should have the 'overrides[1]' config data of 'eslint-config-override' at the third element.", () => {
                    assertConfigArrayElement(configArray[2], {
                        name: ".eslintrc » eslint-config-override#overrides[1]",
                        filePath: path.join(tempDir, "node_modules/eslint-config-override/index.js"),
                        criteria: OverrideTester.create(["*.yyy"], [], tempDir),
                        rules: { override: 2 }
                    });
                });

                it("should have the given config data at the fourth element.", () => {
                    assertConfigArrayElement(configArray[3], {
                        name: ".eslintrc",
                        rules: { eqeqeq: 1 }
                    });
                });
            });
        });

        describe("'overrides' details", () => {
            before(() => {
                const { ConfigArrayFactory } = defineConfigArrayFactoryWithInmemoryFileSystem({
                    cwd: () => tempDir,
                    files: {
                        "node_modules/eslint-config-foo/index.js": `
                            module.exports = {
                                rules: { eqeqeq: "error" }
                            }
                        `,
                        "node_modules/eslint-config-has-overrides/index.js": `
                            module.exports = {
                                rules: { eqeqeq: "error" },
                                overrides: [
                                    {
                                        files: ["**/foo/**/*.js"],
                                        rules: { eqeqeq: "off" }
                                    }
                                ]
                            }
                        `,
                        "node_modules/eslint-config-root/index.js": `
                            module.exports = {
                                root: true,
                                rules: { eqeqeq: "error" }
                            }
                        `
                    }
                });

                factory = new ConfigArrayFactory();
            });

            describe("if 'overrides' property was given, the returned value", () => {
                let configArray;

                beforeEach(() => {
                    configArray = create({
                        rules: { regular: 1 },
                        overrides: [
                            { files: "*.xxx", rules: { override: 1 } },
                            { files: "*.yyy", rules: { override: 2 } }
                        ]
                    });
                });

                it("should have three elements.", () => {
                    assert.strictEqual(configArray.length, 3);
                });

                it("should have the given config data at the first element.", () => {
                    assertConfigArrayElement(configArray[0], {
                        rules: { regular: 1 }
                    });
                });

                it("should have the config data of 'overrides[0]' at the second element.", () => {
                    assertConfigArrayElement(configArray[1], {
                        name: "#overrides[0]",
                        criteria: OverrideTester.create(["*.xxx"], [], tempDir),
                        rules: { override: 1 }
                    });
                });

                it("should have the config data of 'overrides[1]' at the third element.", () => {
                    assertConfigArrayElement(configArray[2], {
                        name: "#overrides[1]",
                        criteria: OverrideTester.create(["*.yyy"], [], tempDir),
                        rules: { override: 2 }
                    });
                });
            });

            describe("if a config in 'overrides' property had 'extends' property, the returned value", () => {
                let configArray;

                beforeEach(() => {
                    configArray = create({
                        rules: { regular: 1 },
                        overrides: [
                            {
                                files: "*.xxx",
                                extends: "foo",
                                rules: { override: 1 }
                            }
                        ]
                    });
                });

                it("should have three elements.", () => {
                    assert.strictEqual(configArray.length, 3);
                });

                it("should have the given config data at the first element.", () => {
                    assertConfigArrayElement(configArray[0], {
                        rules: { regular: 1 }
                    });
                });

                it("should have the config data of 'overrides[0] » eslint-config-foo' at the second element.", () => {
                    assertConfigArrayElement(configArray[1], {
                        name: "#overrides[0] » eslint-config-foo",
                        filePath: path.join(tempDir, "node_modules/eslint-config-foo/index.js"),
                        criteria: OverrideTester.create(["*.xxx"], [], tempDir),
                        rules: { eqeqeq: "error" }
                    });
                });

                it("should have the config data of 'overrides[0]' at the third element.", () => {
                    assertConfigArrayElement(configArray[2], {
                        name: "#overrides[0]",
                        criteria: OverrideTester.create(["*.xxx"], [], tempDir),
                        rules: { override: 1 }
                    });
                });
            });

            describe("if a config in 'overrides' property had 'extends' property and the shareable config has 'overrides' property, the returned value", () => {
                let configArray;

                beforeEach(() => {
                    configArray = create({
                        rules: { regular: 1 },
                        overrides: [
                            {
                                files: "*.xxx",
                                extends: "has-overrides",
                                rules: { override: 1 }
                            }
                        ]
                    });
                });

                it("should have four elements.", () => {
                    assert.strictEqual(configArray.length, 4);
                });

                it("should have the given config data at the first element.", () => {
                    assertConfigArrayElement(configArray[0], {
                        rules: { regular: 1 }
                    });
                });

                it("should have the config data of 'overrides[0] » eslint-config-has-overrides' at the second element.", () => {
                    assertConfigArrayElement(configArray[1], {
                        name: "#overrides[0] » eslint-config-has-overrides",
                        filePath: path.join(tempDir, "node_modules/eslint-config-has-overrides/index.js"),
                        criteria: OverrideTester.create(["*.xxx"], [], tempDir),
                        rules: { eqeqeq: "error" }
                    });
                });

                it("should have the config data of 'overrides[0] » eslint-config-has-overrides#overrides[0]' at the third element.", () => {
                    assertConfigArrayElement(configArray[2], {
                        name: "#overrides[0] » eslint-config-has-overrides#overrides[0]",
                        filePath: path.join(tempDir, "node_modules/eslint-config-has-overrides/index.js"),
                        criteria: OverrideTester.and(
                            OverrideTester.create(["*.xxx"], [], tempDir),
                            OverrideTester.create(["**/foo/**/*.js"], [], tempDir)
                        ),
                        rules: { eqeqeq: "off" }
                    });
                });

                it("should have the config data of 'overrides[0]' at the fourth element.", () => {
                    assertConfigArrayElement(configArray[3], {
                        name: "#overrides[0]",
                        criteria: OverrideTester.create(["*.xxx"], [], tempDir),
                        rules: { override: 1 }
                    });
                });
            });

            describe("if a config in 'overrides' property had 'overrides' property, the returned value", () => {
                let configArray;

                beforeEach(() => {
                    configArray = create({
                        rules: { regular: 1 },
                        overrides: [
                            {
                                files: "*.xxx",
                                rules: { override: 1 },
                                overrides: [
                                    {
                                        files: "*.yyy",
                                        rules: { override: 2 }
                                    }
                                ]
                            }
                        ]
                    });
                });

                it("should have three elements.", () => {
                    assert.strictEqual(configArray.length, 3);
                });

                it("should have the given config data at the first element.", () => {
                    assertConfigArrayElement(configArray[0], {
                        rules: { regular: 1 }
                    });
                });

                it("should have the config data of 'overrides[0]' at the second element.", () => {
                    assertConfigArrayElement(configArray[1], {
                        name: "#overrides[0]",
                        criteria: OverrideTester.create(["*.xxx"], [], tempDir),
                        rules: { override: 1 }
                    });
                });

                it("should have the config data of 'overrides[0].overrides[0]' at the third element.", () => {
                    assertConfigArrayElement(configArray[2], {
                        name: "#overrides[0]#overrides[0]",
                        criteria: OverrideTester.and(
                            OverrideTester.create(["*.xxx"], [], tempDir),
                            OverrideTester.create(["*.yyy"], [], tempDir)
                        ),
                        rules: { override: 2 }
                    });
                });
            });

            describe("if a config in 'overrides' property had 'root' property, the returned value", () => {
                let configArray;

                beforeEach(() => {
                    configArray = create({
                        rules: { regular: 1 },
                        overrides: [
                            {
                                files: "*.xxx",
                                extends: "root",
                                rules: { override: 1 }
                            }
                        ]
                    });
                });

                it("should have three elements.", () => {
                    assert.strictEqual(configArray.length, 3);
                });

                it("should have the given config data at the first element.", () => {
                    assertConfigArrayElement(configArray[0], {
                        rules: { regular: 1 }
                    });
                });

                it("should have the config data of 'overrides[0] » eslint-config-root' at the second element; it doesn't have 'root' property.", () => {
                    assertConfigArrayElement(configArray[1], {
                        name: "#overrides[0] » eslint-config-root",
                        filePath: path.join(tempDir, "node_modules/eslint-config-root/index.js"),
                        criteria: OverrideTester.create(["*.xxx"], [], tempDir),
                        rules: { eqeqeq: "error" }
                    });
                });

                it("should have the config data of 'overrides[0]' at the third element.", () => {
                    assertConfigArrayElement(configArray[2], {
                        name: "#overrides[0]",
                        criteria: OverrideTester.create(["*.xxx"], [], tempDir),
                        rules: { override: 1 }
                    });
                });
            });
        });

        describe("additional parser/plugin pool", () => {
            const parser = {};
            const plugin = {};

            beforeEach(() => {
                const { ConfigArrayFactory } = defineConfigArrayFactoryWithInmemoryFileSystem({
                    cwd: () => tempDir
                });

                factory = new ConfigArrayFactory({
                    additionalParserPool: new Map([["parser", parser]]),
                    additionalPluginPool: new Map([["abc", plugin], ["eslint-plugin-def", plugin]])
                });
            });

            it("should use the matched parser in the additional parser pool.", () => {
                const configArray = create({ parser: "parser" });

                assert.strictEqual(configArray[0].parser.id, "parser");
                assert.strictEqual(configArray[0].parser.definition, parser);
            });

            it("should use the matched plugin in the additional plugin pool; short to short", () => {
                const configArray = create({ plugins: ["abc"] });

                assert.strictEqual(configArray[0].plugins.abc.id, "abc");
                assert.strictEqual(configArray[0].plugins.abc.definition, plugin);
            });

            it("should use the matched plugin in the additional plugin pool; long to short", () => {
                const configArray = create({ plugins: ["eslint-plugin-abc"] });

                assert.strictEqual(configArray[0].plugins.abc.id, "abc");
                assert.strictEqual(configArray[0].plugins.abc.definition, plugin);
            });

            it("should use the matched plugin in the additional plugin pool; short to long", () => {
                const configArray = create({ plugins: ["def"] });

                assert.strictEqual(configArray[0].plugins.def.id, "def");
                assert.strictEqual(configArray[0].plugins.def.definition, plugin);
            });

            it("should use the matched plugin in the additional plugin pool; long to long", () => {
                const configArray = create({ plugins: ["eslint-plugin-def"] });

                assert.strictEqual(configArray[0].plugins.def.id, "def");
                assert.strictEqual(configArray[0].plugins.def.definition, plugin);
            });
        });
    });

    describe("Moved from tests/lib/config/config-file.js", () => {
        describe("applyExtends()", () => {
            const files = {
                "node_modules/eslint-config-foo/index.js": "exports.env = { browser: true }",
                "node_modules/eslint-config-one/index.js": "module.exports = { extends: 'two', env: { browser: true } }",
                "node_modules/eslint-config-two/index.js": "module.exports = { env: { node: true } }",
                "node_modules/eslint-plugin-invalid-parser/index.js": "exports.configs = { foo: { parser: 'babel-eslint' } }",
                "node_modules/eslint-plugin-invalid-config/index.js": "exports.configs = { foo: {} }",
                "js/.eslintrc.js": "module.exports = { rules: { semi: [2, 'always'] } };",
                "json/.eslintrc.json": "{ \"rules\": { \"quotes\": [2, \"double\"] } }",
                "package-json/package.json": "{ \"eslintConfig\": { \"env\": { \"es6\": true } } }",
                "yaml/.eslintrc.yaml": "env:\n    browser: true"
            };
            const { ConfigArrayFactory } = defineConfigArrayFactoryWithInmemoryFileSystem({ files });
            const factory = new ConfigArrayFactory();

            /**
             * Apply `extends` property.
             * @param {Object} configData The config that has `extends` property.
             * @param {string} [filePath] The path to the config data.
             * @returns {Object} The applied config data.
             */
            function applyExtends(configData, filePath = "whatever") {
                return factory
                    .create(configData, { filePath })
                    .extractConfig(filePath)
                    .toCompatibleObjectAsConfigFileContent();
            }

            it("should apply extension 'foo' when specified from root directory config", () => {
                const config = applyExtends({
                    extends: "foo",
                    rules: { eqeqeq: 2 }
                });

                assertConfig(config, {
                    env: { browser: true },
                    rules: { eqeqeq: [2] }
                });
            });

            it("should apply all rules when extends config includes 'eslint:all'", () => {
                const config = applyExtends({
                    extends: "eslint:all"
                });

                assert.strictEqual(config.rules.eqeqeq[0], "error");
                assert.strictEqual(config.rules.curly[0], "error");
            });

            it("should throw an error when extends config module is not found", () => {
                assert.throws(() => {
                    applyExtends({
                        extends: "not-exist",
                        rules: { eqeqeq: 2 }
                    });
                }, /Failed to load config "not-exist" to extend from./u);
            });

            it("should throw an error when an eslint config is not found", () => {
                assert.throws(() => {
                    applyExtends({
                        extends: "eslint:foo",
                        rules: { eqeqeq: 2 }
                    });
                }, /Failed to load config "eslint:foo" to extend from./u);
            });

            it("should throw an error when a parser in a plugin config is not found", () => {
                assert.throws(() => {
                    applyExtends({
                        extends: "plugin:invalid-parser/foo",
                        rules: { eqeqeq: 2 }
                    });
                }, /Cannot find module 'babel-eslint'/u);
            });

            it("should throw an error when a plugin config is not found", () => {
                assert.throws(() => {
                    applyExtends({
                        extends: "plugin:invalid-config/bar",
                        rules: { eqeqeq: 2 }
                    });
                }, /Failed to load config "plugin:invalid-config\/bar" to extend from./u);
            });

            it("should apply extensions recursively when specified from package", () => {
                const config = applyExtends({
                    extends: "one",
                    rules: { eqeqeq: 2 }
                });

                assertConfig(config, {
                    env: { browser: true, node: true },
                    rules: { eqeqeq: [2] }
                });
            });

            it("should apply extensions when specified from a JavaScript file", () => {
                const config = applyExtends({
                    extends: ".eslintrc.js",
                    rules: { eqeqeq: 2 }
                }, "js/foo.js");

                assertConfig(config, {
                    rules: {
                        semi: [2, "always"],
                        eqeqeq: [2]
                    }
                });
            });

            it("should apply extensions when specified from a YAML file", () => {
                const config = applyExtends({
                    extends: ".eslintrc.yaml",
                    rules: { eqeqeq: 2 }
                }, "yaml/foo.js");

                assertConfig(config, {
                    env: { browser: true },
                    rules: {
                        eqeqeq: [2]
                    }
                });
            });

            it("should apply extensions when specified from a JSON file", () => {
                const config = applyExtends({
                    extends: ".eslintrc.json",
                    rules: { eqeqeq: 2 }
                }, "json/foo.js");

                assertConfig(config, {
                    rules: {
                        eqeqeq: [2],
                        quotes: [2, "double"]
                    }
                });
            });

            it("should apply extensions when specified from a package.json file in a sibling directory", () => {
                const config = applyExtends({
                    extends: "../package-json/package.json",
                    rules: { eqeqeq: 2 }
                }, "json/foo.js");

                assertConfig(config, {
                    env: { es6: true },
                    rules: {
                        eqeqeq: [2]
                    }
                });
            });
        });

        describe("load()", () => {

            /**
             * Load a given config file.
             * @param {ConfigArrayFactory} factory The factory to load.
             * @param {string} filePath The path to a config file.
             * @returns {Object} The applied config data.
             */
            function load(factory, filePath) {
                return factory
                    .loadFile(filePath)
                    .extractConfig(filePath)
                    .toCompatibleObjectAsConfigFileContent();
            }

            it("should throw error if file doesnt exist", () => {
                const { ConfigArrayFactory } = defineConfigArrayFactoryWithInmemoryFileSystem();
                const factory = new ConfigArrayFactory();

                assert.throws(() => {
                    load(factory, "legacy/nofile.js");
                });

                assert.throws(() => {
                    load(factory, "legacy/package.json");
                });
            });

            it("should load information from a legacy file", () => {
                const { ConfigArrayFactory } = defineConfigArrayFactoryWithInmemoryFileSystem({
                    files: {
                        "legacy/.eslintrc": "{ rules: { eqeqeq: 2 } }"
                    }
                });
                const factory = new ConfigArrayFactory();
                const config = load(factory, "legacy/.eslintrc");

                assertConfig(config, {
                    rules: {
                        eqeqeq: [2]
                    }
                });
            });

            it("should load information from a JavaScript file", () => {
                const { ConfigArrayFactory } = defineConfigArrayFactoryWithInmemoryFileSystem({
                    files: {
                        "js/.eslintrc.js": "module.exports = { rules: { semi: [2, 'always'] } };"
                    }
                });
                const factory = new ConfigArrayFactory();
                const config = load(factory, "js/.eslintrc.js");

                assertConfig(config, {
                    rules: {
                        semi: [2, "always"]
                    }
                });
            });

            it("should throw error when loading invalid JavaScript file", () => {
                const { ConfigArrayFactory } = defineConfigArrayFactoryWithInmemoryFileSystem({
                    files: {
                        "js/.eslintrc.broken.js": "module.exports = { rules: { semi: [2, 'always'] }"
                    }
                });
                const factory = new ConfigArrayFactory();

                assert.throws(() => {
                    load(factory, "js/.eslintrc.broken.js");
                }, /Cannot read config file/u);
            });

            it("should interpret parser module name when present in a JavaScript file", () => {
                const { ConfigArrayFactory } = defineConfigArrayFactoryWithInmemoryFileSystem({
                    files: {
                        "node_modules/foo/index.js": "",
                        "js/node_modules/foo/index.js": "",
                        "js/.eslintrc.parser.js": `module.exports = {
                            parser: 'foo',
                            rules: { semi: [2, 'always'] }
                        };`
                    }
                });
                const factory = new ConfigArrayFactory();
                const config = load(factory, "js/.eslintrc.parser.js");

                assertConfig(config, {
                    parser: path.resolve("js/node_modules/foo/index.js"),
                    rules: {
                        semi: [2, "always"]
                    }
                });
            });

            it("should interpret parser path when present in a JavaScript file", () => {
                const { ConfigArrayFactory } = defineConfigArrayFactoryWithInmemoryFileSystem({
                    files: {
                        "js/.eslintrc.parser2.js": `module.exports = {
                            parser: './not-a-config.js',
                            rules: { semi: [2, 'always'] }
                        };`,
                        "js/not-a-config.js": ""
                    }
                });
                const factory = new ConfigArrayFactory();
                const config = load(factory, "js/.eslintrc.parser2.js");

                assertConfig(config, {
                    parser: path.resolve("js/not-a-config.js"),
                    rules: {
                        semi: [2, "always"]
                    }
                });
            });

            it("should interpret parser module name or path when parser is set to default parser in a JavaScript file", () => {
                const { ConfigArrayFactory } = defineConfigArrayFactoryWithInmemoryFileSystem({
                    files: {
                        "js/.eslintrc.parser3.js": `module.exports = {
                            parser: 'espree',
                            rules: { semi: [2, 'always'] }
                        };`
                    }
                });
                const factory = new ConfigArrayFactory();
                const config = load(factory, "js/.eslintrc.parser3.js");

                assertConfig(config, {
                    parser: require.resolve("espree"),
                    rules: {
                        semi: [2, "always"]
                    }
                });
            });

            it("should load information from a JSON file", () => {
                const { ConfigArrayFactory } = defineConfigArrayFactoryWithInmemoryFileSystem({
                    files: {
                        "json/.eslintrc.json": "{ \"rules\": { \"quotes\": [2, \"double\"] } }"
                    }
                });
                const factory = new ConfigArrayFactory();
                const config = load(factory, "json/.eslintrc.json");

                assertConfig(config, {
                    rules: {
                        quotes: [2, "double"]
                    }
                });
            });

            it("should load fresh information from a JSON file", () => {
                const { fs, ConfigArrayFactory } = defineConfigArrayFactoryWithInmemoryFileSystem();
                const factory = new ConfigArrayFactory();
                const initialConfig = {
                    rules: {
                        quotes: [2, "double"]
                    }
                };
                const updatedConfig = {
                    rules: {
                        quotes: [0]
                    }
                };
                let config;

                fs.writeFileSync("fresh-test.json", JSON.stringify(initialConfig));
                config = load(factory, "fresh-test.json");
                assertConfig(config, initialConfig);

                fs.writeFileSync("fresh-test.json", JSON.stringify(updatedConfig));
                config = load(factory, "fresh-test.json");
                assertConfig(config, updatedConfig);
            });

            it("should load information from a package.json file", () => {
                const { ConfigArrayFactory } = defineConfigArrayFactoryWithInmemoryFileSystem({
                    files: {
                        "package-json/package.json": "{ \"eslintConfig\": { \"env\": { \"es6\": true } } }"
                    }
                });
                const factory = new ConfigArrayFactory();
                const config = load(factory, "package-json/package.json");

                assertConfig(config, {
                    env: { es6: true }
                });
            });

            it("should throw error when loading invalid package.json file", () => {
                const { ConfigArrayFactory } = defineConfigArrayFactoryWithInmemoryFileSystem({
                    files: {
                        "broken-package-json/package.json": "{ \"eslintConfig\": { \"env\": { \"es6\": true } }"
                    }
                });
                const factory = new ConfigArrayFactory();

                assert.throws(() => {
                    try {
                        load(factory, "broken-package-json/package.json");
                    } catch (error) {
                        assert.strictEqual(error.messageTemplate, "failed-to-read-json");
                        throw error;
                    }
                }, /Cannot read config file/u);
            });

            it("should load fresh information from a package.json file", () => {
                const { fs, ConfigArrayFactory } = defineConfigArrayFactoryWithInmemoryFileSystem();
                const factory = new ConfigArrayFactory();
                const initialConfig = {
                    eslintConfig: {
                        rules: {
                            quotes: [2, "double"]
                        }
                    }
                };
                const updatedConfig = {
                    eslintConfig: {
                        rules: {
                            quotes: [0]
                        }
                    }
                };
                let config;

                fs.writeFileSync("package.json", JSON.stringify(initialConfig));
                config = load(factory, "package.json");
                assertConfig(config, initialConfig.eslintConfig);

                fs.writeFileSync("package.json", JSON.stringify(updatedConfig));
                config = load(factory, "package.json");
                assertConfig(config, updatedConfig.eslintConfig);
            });

            it("should load fresh information from a .eslintrc.js file", () => {
                const { fs, ConfigArrayFactory } = defineConfigArrayFactoryWithInmemoryFileSystem();
                const factory = new ConfigArrayFactory();
                const initialConfig = {
                    rules: {
                        quotes: [2, "double"]
                    }
                };
                const updatedConfig = {
                    rules: {
                        quotes: [0]
                    }
                };
                let config;

                fs.writeFileSync(".eslintrc.js", `module.exports = ${JSON.stringify(initialConfig)}`);
                config = load(factory, ".eslintrc.js");
                assertConfig(config, initialConfig);

                fs.writeFileSync(".eslintrc.js", `module.exports = ${JSON.stringify(updatedConfig)}`);
                config = load(factory, ".eslintrc.js");
                assertConfig(config, updatedConfig);
            });

            it("should load information from a YAML file", () => {
                const { ConfigArrayFactory } = defineConfigArrayFactoryWithInmemoryFileSystem({
                    files: {
                        "yaml/.eslintrc.yaml": "env:\n    browser: true"
                    }
                });
                const factory = new ConfigArrayFactory();
                const config = load(factory, "yaml/.eslintrc.yaml");

                assertConfig(config, {
                    env: { browser: true }
                });
            });

            it("should load information from an empty YAML file", () => {
                const { ConfigArrayFactory } = defineConfigArrayFactoryWithInmemoryFileSystem({
                    files: {
                        "yaml/.eslintrc.empty.yaml": "{}"
                    }
                });
                const factory = new ConfigArrayFactory();
                const config = load(factory, "yaml/.eslintrc.empty.yaml");

                assertConfig(config, {});
            });

            it("should load information from a YML file", () => {
                const { ConfigArrayFactory } = defineConfigArrayFactoryWithInmemoryFileSystem({
                    files: {
                        "yml/.eslintrc.yml": "env:\n    node: true"
                    }
                });
                const factory = new ConfigArrayFactory();
                const config = load(factory, "yml/.eslintrc.yml");

                assertConfig(config, {
                    env: { node: true }
                });
            });

            it("should load information from a YML file and apply extensions", () => {
                const { ConfigArrayFactory } = defineConfigArrayFactoryWithInmemoryFileSystem({
                    files: {
                        "extends/.eslintrc.yml": "extends: ../package-json/package.json\nrules:\n    booya: 2",
                        "package-json/package.json": "{ \"eslintConfig\": { \"env\": { \"es6\": true } } }"
                    }
                });
                const factory = new ConfigArrayFactory();
                const config = load(factory, "extends/.eslintrc.yml");

                assertConfig(config, {
                    env: { es6: true },
                    rules: { booya: [2] }
                });
            });

            it("should load information from `extends` chain.", () => {
                const { ConfigArrayFactory } = defineConfigArrayFactoryWithInmemoryFileSystem({
                    files: {
                        "extends-chain": {
                            "node_modules/eslint-config-a": {
                                "node_modules/eslint-config-b": {
                                    "node_modules/eslint-config-c": {
                                        "index.js": "module.exports = { rules: { c: 2 } };"
                                    },
                                    "index.js": "module.exports = { extends: 'c', rules: { b: 2 } };"
                                },
                                "index.js": "module.exports = { extends: 'b', rules: { a: 2 } };"
                            },
                            ".eslintrc.json": "{ \"extends\": \"a\" }"
                        }
                    }
                });
                const factory = new ConfigArrayFactory();
                const config = load(factory, "extends-chain/.eslintrc.json");

                assertConfig(config, {
                    rules: {
                        a: [2], // from node_modules/eslint-config-a
                        b: [2], // from node_modules/eslint-config-a/node_modules/eslint-config-b
                        c: [2] // from node_modules/eslint-config-a/node_modules/eslint-config-b/node_modules/eslint-config-c
                    }
                });
            });

            it("should load information from `extends` chain with relative path.", () => {
                const { ConfigArrayFactory } = defineConfigArrayFactoryWithInmemoryFileSystem({
                    files: {
                        "extends-chain-2": {
                            "node_modules/eslint-config-a/index.js": "module.exports = { extends: './relative.js', rules: { a: 2 } };",
                            "node_modules/eslint-config-a/relative.js": "module.exports = { rules: { relative: 2 } };",
                            ".eslintrc.json": "{ \"extends\": \"a\" }"
                        }
                    }
                });
                const factory = new ConfigArrayFactory();
                const config = load(factory, "extends-chain-2/.eslintrc.json");

                assertConfig(config, {
                    rules: {
                        a: [2], // from node_modules/eslint-config-a/index.js
                        relative: [2] // from node_modules/eslint-config-a/relative.js
                    }
                });
            });

            it("should load information from `extends` chain in .eslintrc with relative path.", () => {
                const { ConfigArrayFactory } = defineConfigArrayFactoryWithInmemoryFileSystem({
                    files: {
                        "extends-chain-2": {
                            "node_modules/eslint-config-a/index.js": "module.exports = { extends: './relative.js', rules: { a: 2 } };",
                            "node_modules/eslint-config-a/relative.js": "module.exports = { rules: { relative: 2 } };",
                            "relative.eslintrc.json": "{ \"extends\": \"./node_modules/eslint-config-a/index.js\" }"
                        }
                    }
                });
                const factory = new ConfigArrayFactory();
                const config = load(factory, "extends-chain-2/relative.eslintrc.json");

                assertConfig(config, {
                    rules: {
                        a: [2], // from node_modules/eslint-config-a/index.js
                        relative: [2] // from node_modules/eslint-config-a/relative.js
                    }
                });
            });

            it("should load information from `parser` in .eslintrc with relative path.", () => {
                const { ConfigArrayFactory } = defineConfigArrayFactoryWithInmemoryFileSystem({
                    files: {
                        "extends-chain-2": {
                            "parser.eslintrc.json": "{ \"parser\": \"./parser.js\" }",
                            "parser.js": ""
                        }
                    }
                });
                const factory = new ConfigArrayFactory();
                const config = load(factory, "extends-chain-2/parser.eslintrc.json");

                assertConfig(config, {
                    parser: path.resolve("extends-chain-2/parser.js")
                });
            });

            describe("Plugins", () => {
                it("should load information from a YML file and load plugins", () => {
                    const { ConfigArrayFactory } = defineConfigArrayFactoryWithInmemoryFileSystem({
                        files: {
                            "node_modules/eslint-plugin-test/index.js": `
                                module.exports = {
                                    environments: {
                                        bar: { globals: { bar: true } }
                                    }
                                }
                            `,
                            "plugins/.eslintrc.yml": `
                                plugins:
                                  - test
                                rules:
                                    test/foo: 2
                                env:
                                    test/bar: true
                            `
                        }
                    });
                    const factory = new ConfigArrayFactory();
                    const config = load(factory, "plugins/.eslintrc.yml");

                    assertConfig(config, {
                        env: { "test/bar": true },
                        plugins: ["test"],
                        rules: {
                            "test/foo": [2]
                        }
                    });
                });

                it("should load two separate configs from a plugin", () => {
                    const { ConfigArrayFactory } = defineConfigArrayFactoryWithInmemoryFileSystem({
                        files: {
                            "node_modules/eslint-plugin-test/index.js": `
                                module.exports = {
                                    configs: {
                                        foo: { rules: { semi: 2, quotes: 1 } },
                                        bar: { rules: { quotes: 2, yoda: 2 } }
                                    }
                                }
                            `,
                            "plugins/.eslintrc.yml": `
                                extends:
                                    - plugin:test/foo
                                    - plugin:test/bar
                            `
                        }
                    });
                    const factory = new ConfigArrayFactory();
                    const config = load(factory, "plugins/.eslintrc.yml");

                    assertConfig(config, {
                        rules: {
                            semi: [2],
                            quotes: [2],
                            yoda: [2]
                        }
                    });
                });
            });

            describe("even if config files have Unicode BOM,", () => {
                it("should read the JSON config file correctly.", () => {
                    const { ConfigArrayFactory } = defineConfigArrayFactoryWithInmemoryFileSystem({
                        files: {
                            "bom/.eslintrc.json": "\uFEFF{ \"rules\": { \"semi\": \"error\" } }"
                        }
                    });
                    const factory = new ConfigArrayFactory();
                    const config = load(factory, "bom/.eslintrc.json");

                    assertConfig(config, {
                        rules: {
                            semi: ["error"]
                        }
                    });
                });

                it("should read the YAML config file correctly.", () => {
                    const { ConfigArrayFactory } = defineConfigArrayFactoryWithInmemoryFileSystem({
                        files: {
                            "bom/.eslintrc.yaml": "\uFEFFrules:\n  semi: error"
                        }
                    });
                    const factory = new ConfigArrayFactory();
                    const config = load(factory, "bom/.eslintrc.yaml");

                    assertConfig(config, {
                        rules: {
                            semi: ["error"]
                        }
                    });
                });

                it("should read the config in package.json correctly.", () => {
                    const { ConfigArrayFactory } = defineConfigArrayFactoryWithInmemoryFileSystem({
                        files: {
                            "bom/package.json": "\uFEFF{ \"eslintConfig\": { \"rules\": { \"semi\": \"error\" } } }"
                        }
                    });
                    const factory = new ConfigArrayFactory();
                    const config = load(factory, "bom/package.json");

                    assertConfig(config, {
                        rules: {
                            semi: ["error"]
                        }
                    });
                });
            });

            it("throws an error including the config file name if the config file is invalid", () => {
                const { ConfigArrayFactory } = defineConfigArrayFactoryWithInmemoryFileSystem({
                    files: {
                        "invalid/invalid-top-level-property.yml": "invalidProperty: 3"
                    }
                });
                const factory = new ConfigArrayFactory();

                try {
                    load(factory, "invalid/invalid-top-level-property.yml");
                } catch (err) {
                    assert.include(err.message, `ESLint configuration in ${`invalid${path.sep}invalid-top-level-property.yml`} is invalid`);
                    return;
                }
                assert.fail();
            });
        });

        describe("resolve()", () => {
            const { ConfigArrayFactory } = defineConfigArrayFactoryWithInmemoryFileSystem({
                cwd: () => tempDir,
                files: {
                    "node_modules/eslint-config-foo/index.js": "",
                    "node_modules/eslint-config-foo/bar.js": "",
                    "node_modules/eslint-config-eslint-configfoo/index.js": "",
                    "node_modules/@foo/eslint-config/index.js": "",
                    "node_modules/@foo/eslint-config-bar/index.js": "",
                    "node_modules/eslint-plugin-foo/index.js": "exports.configs = { bar: {} }",
                    "node_modules/@foo/eslint-plugin/index.js": "exports.configs = { bar: {} }",
                    "node_modules/@foo/eslint-plugin-bar/index.js": "exports.configs = { baz: {} }",
                    "foo/bar/.eslintrc": "",
                    ".eslintrc": ""
                }
            });
            const factory = new ConfigArrayFactory();

            /**
             * Resolve `extends` module.
             * @param {string} request The module name to resolve.
             * @param {string} [relativeTo] The importer path to resolve.
             * @returns {string} The resolved path.
             */
            function resolve(request, relativeTo) {
                return factory.create(
                    { extends: request },
                    { filePath: relativeTo }
                )[0];
            }

            describe("Relative to CWD", () => {
                for (const { input, expected } of [
                    { input: ".eslintrc", expected: path.resolve(tempDir, ".eslintrc") },
                    { input: "eslint-config-foo", expected: path.resolve(tempDir, "node_modules/eslint-config-foo/index.js") },
                    { input: "eslint-config-foo/bar", expected: path.resolve(tempDir, "node_modules/eslint-config-foo/bar.js") },
                    { input: "foo", expected: path.resolve(tempDir, "node_modules/eslint-config-foo/index.js") },
                    { input: "foo/bar", expected: path.resolve(tempDir, "node_modules/eslint-config-foo/bar.js") },
                    { input: "eslint-configfoo", expected: path.resolve(tempDir, "node_modules/eslint-config-eslint-configfoo/index.js") },
                    { input: "@foo/eslint-config", expected: path.resolve(tempDir, "node_modules/@foo/eslint-config/index.js") },
                    { input: "@foo", expected: path.resolve(tempDir, "node_modules/@foo/eslint-config/index.js") },
                    { input: "@foo/bar", expected: path.resolve(tempDir, "node_modules/@foo/eslint-config-bar/index.js") },
                    { input: "plugin:foo/bar", expected: path.resolve(tempDir, "node_modules/eslint-plugin-foo/index.js") },
                    { input: "plugin:@foo/bar", expected: path.resolve(tempDir, "node_modules/@foo/eslint-plugin/index.js") },
                    { input: "plugin:@foo/bar/baz", expected: path.resolve(tempDir, "node_modules/@foo/eslint-plugin-bar/index.js") }
                ]) {
                    it(`should return ${expected} when passed ${input}`, () => {
                        const result = resolve(input);

                        assert.strictEqual(result.filePath, expected);
                    });
                }
            });

            describe("Relative to config file", () => {
                const relativePath = path.resolve(tempDir, "./foo/bar/.eslintrc");

                for (const { input, expected } of [
                    { input: ".eslintrc", expected: path.join(path.dirname(relativePath), ".eslintrc") },
                    { input: "eslint-config-foo", expected: path.resolve(tempDir, "node_modules/eslint-config-foo/index.js") },
                    { input: "eslint-config-foo/bar", expected: path.resolve(tempDir, "node_modules/eslint-config-foo/bar.js") },
                    { input: "foo", expected: path.resolve(tempDir, "node_modules/eslint-config-foo/index.js") },
                    { input: "foo/bar", expected: path.resolve(tempDir, "node_modules/eslint-config-foo/bar.js") },
                    { input: "eslint-configfoo", expected: path.resolve(tempDir, "node_modules/eslint-config-eslint-configfoo/index.js") },
                    { input: "@foo/eslint-config", expected: path.resolve(tempDir, "node_modules/@foo/eslint-config/index.js") },
                    { input: "@foo", expected: path.resolve(tempDir, "node_modules/@foo/eslint-config/index.js") },
                    { input: "@foo/bar", expected: path.resolve(tempDir, "node_modules/@foo/eslint-config-bar/index.js") },
                    { input: "plugin:foo/bar", expected: path.resolve(tempDir, "node_modules/eslint-plugin-foo/index.js") },
                    { input: "plugin:@foo/bar", expected: path.resolve(tempDir, "node_modules/@foo/eslint-plugin/index.js") },
                    { input: "plugin:@foo/bar/baz", expected: path.resolve(tempDir, "node_modules/@foo/eslint-plugin-bar/index.js") }
                ]) {
                    it(`should return ${expected} when passed ${input}`, () => {
                        const result = resolve(input, relativePath);

                        assert.strictEqual(result.filePath, expected);
                    });
                }
            });
        });
    });

    describe("Moved from tests/lib/config/plugins.js", () => {
        describe("load()", () => {
            const { ConfigArrayFactory } = defineConfigArrayFactoryWithInmemoryFileSystem({
                cwd: () => tempDir,
                files: {
                    "node_modules/@scope/eslint-plugin-example/index.js": "exports.name = '@scope/eslint-plugin-example';",
                    "node_modules/eslint-plugin-example/index.js": "exports.name = 'eslint-plugin-example';",
                    "node_modules/eslint-plugin-throws-on-load/index.js": "throw new Error('error thrown while loading this module')"
                }
            });
            const factory = new ConfigArrayFactory();

            /**
             * Load a plugin.
             * @param {string} request A request to load a plugin.
             * @returns {Map<string,Object>} The loaded plugins.
             */
            function load(request) {
                const config = factory.create({ plugins: [request] });

                return new Map(
                    Object
                        .entries(config[0].plugins)
                        .map(([id, entry]) => {
                            if (entry.error) {
                                throw entry.error;
                            }
                            return [id, entry.definition];
                        })
                );
            }

            it("should load a plugin when referenced by short name", () => {
                const loadedPlugins = load("example");

                assert.deepStrictEqual(
                    loadedPlugins.get("example"),
                    { name: "eslint-plugin-example" }
                );
            });

            it("should load a plugin when referenced by long name", () => {
                const loadedPlugins = load("eslint-plugin-example");

                assert.deepStrictEqual(
                    loadedPlugins.get("example"),
                    { name: "eslint-plugin-example" }
                );
            });

            it("should throw an error when a plugin has whitespace", () => {
                assert.throws(() => {
                    load("whitespace ");
                }, /Whitespace found in plugin name 'whitespace '/u);
                assert.throws(() => {
                    load("whitespace\t");
                }, /Whitespace found in plugin name/u);
                assert.throws(() => {
                    load("whitespace\n");
                }, /Whitespace found in plugin name/u);
                assert.throws(() => {
                    load("whitespace\r");
                }, /Whitespace found in plugin name/u);
            });

            it("should throw an error when a plugin doesn't exist", () => {
                assert.throws(() => {
                    load("nonexistentplugin");
                }, /Failed to load plugin/u);
            });

            it("should rethrow an error that a plugin throws on load", () => {
                try {
                    load("throws-on-load");
                } catch (err) {
                    assert.strictEqual(
                        err.message,
                        "error thrown while loading this module",
                        "should rethrow the same error that was thrown on plugin load"
                    );

                    return;
                }
                assert.fail(null, null, "should throw an error if a plugin fails to load");
            });

            it("should load a scoped plugin when referenced by short name", () => {
                const loadedPlugins = load("@scope/example");

                assert.deepStrictEqual(
                    loadedPlugins.get("@scope/example"),
                    { name: "@scope/eslint-plugin-example" }
                );
            });

            it("should load a scoped plugin when referenced by long name", () => {
                const loadedPlugins = load("@scope/eslint-plugin-example");

                assert.deepStrictEqual(
                    loadedPlugins.get("@scope/example"),
                    { name: "@scope/eslint-plugin-example" }
                );
            });

            describe("when referencing a scope plugin and omitting @scope/", () => {
                it("should load a scoped plugin when referenced by short name, but should not get the plugin if '@scope/' is omitted", () => {
                    const loadedPlugins = load("@scope/example");

                    assert.strictEqual(loadedPlugins.get("example"), void 0);
                });

                it("should load a scoped plugin when referenced by long name, but should not get the plugin if '@scope/' is omitted", () => {
                    const loadedPlugins = load("@scope/eslint-plugin-example");

                    assert.strictEqual(loadedPlugins.get("example"), void 0);
                });
            });
        });

        describe("loadAll()", () => {
            const { ConfigArrayFactory } = defineConfigArrayFactoryWithInmemoryFileSystem({
                cwd: () => tempDir,
                files: {
                    "node_modules/eslint-plugin-example1/index.js": "exports.name = 'eslint-plugin-example1';",
                    "node_modules/eslint-plugin-example2/index.js": "exports.name = 'eslint-plugin-example2';"
                }
            });
            const factory = new ConfigArrayFactory();

            /**
             * Load a plugin.
             * @param {string[]} request A request to load a plugin.
             * @returns {Map<string,Object>} The loaded plugins.
             */
            function loadAll(request) {
                const config = factory.create({ plugins: request });

                return new Map(
                    Object
                        .entries(config[0].plugins)
                        .map(([id, entry]) => {
                            if (entry.error) {
                                throw entry.error;
                            }
                            return [id, entry.definition];
                        })
                );
            }

            it("should load plugins when passed multiple plugins", () => {
                const loadedPlugins = loadAll(["example1", "example2"]);

                assert.deepStrictEqual(
                    loadedPlugins.get("example1"),
                    { name: "eslint-plugin-example1" }
                );
                assert.deepStrictEqual(
                    loadedPlugins.get("example2"),
                    { name: "eslint-plugin-example2" }
                );
            });
        });
    });
});
