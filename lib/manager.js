/*jshint esversion:6, node:true*/
'use strict';

const fs = require('fs');
const extend = require('gextend');
const EventEmitter = require('events');

const CSVParser = require('./parsers/csv');
const CSVExporter = require('./exporters/csv');

const JSONParser = require('./parsers/json');
const JSONExporter = require('./exporters/json');

var DEFAULTS = {
    autoinitialize: true,
    importOptions: {
        truncate: false,
        identityFields: ['id', 'uuid'],
        strict: true,
        updateMethod: 'updateOrCreate'
    },
    modelProvider: function(identity) {
        return Promise.reject(new Error('Need to implement'));
    },
    createFileNameFor: function(identity, type) {
        var date = '_' + Date.now();
        return identity + date + '.' + type;
    }
};

class Manager extends EventEmitter {
    constructor(config) {
        super();
        config = extend({}, DEFAULTS, config);

        if (config.autoinitialize) this.init(config);
    }

    init(options) {
        this._parsers = {};
        this._exporters = {};

        new CSVParser(this);
        new CSVExporter(this);
        new JSONParser(this);
        new JSONExporter(this);

        if (!options.logger) options.logger = console;

        extend(this, options);

        this.errors = {};
    }

    addErrors(identity, errors) {
        if (!this.errors[identity]) {
            this.errors[identity] = [];
        }
        this.errors[identity] = this.errors[identity].concat(errors);
    }

    consumeErrorsFor(identity) {
        let errors = this.errors[identity] || [];
        this.errors[identity] = [];
        return errors;
    }

    parser(type, handler) {
        this._parsers[type] = handler;
    }

    exporter(type, handler) {
        this._exporters[type] = handler;
    }

    export (type, records, options = {}) {
        if (!this._exporters[type]) return Promise.reject(new Error('No matching exporter found: ' + type));
        return Promise.resolve(this._exporters[type](records, options));
    }

    import (type, content, options = {}) {

        if (!this._parsers[type]) {
            throw new Error('No matching parser found: ' + type);
        }

        return Promise.resolve(this._parsers[type](content, options)).then((results) => {
            results.map((res) => this.emit('record.' + type, res));
            this.emit('records.' + type, results);
            return results;
        });
    }

    importFile(filename, options = {}) {
        var self = this;
        return new Promise(function(resolve, reject) {
            fs.readFile(filename, (err, content) => {
                if (err) {
                    self.logger.error('importFile %s error', filename);
                    return reject(err);
                }
                content = content.toString();
                var type = require('path').extname(filename).replace('.', '');
                if (options && options.type) type = options.type;

                try {
                    resolve(self.import(type, content, options));
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    importAsModels(identity, type, content, options = {}) {
        return this.import(type, content, options).then((results) => {
            return this._importModel(identity, results, options);
        });
    }

    importFileAsModels(identity, filename, options) {
        return this.importFile(filename, options).then((results) => {
            return this._importModel(identity, results, options);
        });
    }

    _importModel(identity, items, options = {}) {
        options = extend({}, this.importOptions, options);

        if (!items) items = [];
        if (typeof items === 'object' && !Array.isArray(items)) items = [items];

        let self = this;
        let _logger = this.logger;

        return this.modelProvider(identity).then((Model) => {
            if (!Model) return Promise.reject(new Error('Model not found'));

            let attributes = Object.keys(Model._attributes);

            let method = options.truncate ? 'create' : options.updateMethod;

            function iterate(records, options, output = [], errors = []) {
                var record = records.pop();

                if (!record) {
                    if (errors && errors.length) {
                        self.addErrors(identity, errors);
                    }
                    return Promise.resolve(output);
                }

                /*
                 * Make a copy of options, we might
                 * need to modify them.
                 * Same thing with `method`.
                 */
                let o = extend({}, options);
                let updateStrategy = method;

                /*
                 * Call all defined `defaultsTo` that
                 * are not present in our record.
                 * This is good so we get closer
                 * behaviour to `Model.create`.
                 * Also, if some of those fields are
                 * unique then we ensure we can do
                 * a `updateOrCreate`.
                 */
                record = _makeDefaultAttributes(Model, record);

                let identityFields = options.identityFields.concat();
                identityFields =_getIdentityFields(Model, record, identityFields);

                let criteria = {};
                identityFields.map((field) => {
                    if (record[field]) criteria[field] = record[field];
                });

                /*
                 * We need to have a way to perform a
                 * updateOrCreate;
                 */
                if(_emptyCriteria(criteria)) {
                    _logger.warn('We dont have a criteria...');
                    _logger.warn('%j', attributes);
                    _logger.warn('Model keys: %j', Object.keys(Model));
                    //TODO: Not sure if this is the best way to go along?
                    if(o.truncate) {
                        o.truncate = false;
                        updateStrategy = 'create';
                    }
                }

                let args = o.truncate ? [record] : [criteria, record];

                return Model[updateStrategy].apply(Model, args).then((record) => {
                    output.push(record);
                    return iterate(records, options, output, errors);
                }).catch((err) => {

                    let errorMessage = [
                        '_importModel.iterate error',
                        '%s.%s failed: %s',
                        'DataManager does not know what to do with this error.',
                        'They will be bubbled up, you should handle them.'
                    ].join('\n');

                    _logger.error(errorMessage, identity, method, err.message);

                    errors.push(err);
                    return iterate(records, options, output, errors);
                });
            }

            if (options.truncate) {
                return Model.destroy({}).then(() => iterate(items, options));
            } else return iterate(items, options);
        });
    }

    exportModels(identity, query = {}, type = 'json', options = {}) {

        return this.modelProvider(identity).then((Model) => {
            var orm = Model.find(query.criteria || {});

            if (query.populate) {
                if (typeof query.populate === 'string' || Array.isArray(query.populate)) {
                    orm.populate(query.populate);
                } else if (typeof query.populate === 'object') {
                    //TODO: Check we actually have name and criteria :P
                    orm.populate(query.populate.name, query.populate.criteria);
                }
            }
            if (query.skip) orm.skip(query.skip);
            if (query.limit) orm.skip(query.limit);
            if (query.sort) orm.sort(query.sort);

            return orm.then((models) => {
                return this.export(type, models, options);
            });
        });
    }

    exportModelsToFile(identity, query = {}, type = 'json', options = {}) {
        var filename = options.filename || this.createFileNameFor(identity, type);
        console.log('filename:', filename);
        return this.exportModels(identity, query, type, options).then((output) => {
            var defer = Promise.defer();
            fs.writeFile(filename, output, options.fs || 'utf8', function(err) {
                if (err) defer.reject(err);
                else defer.resolve(filename);
            });
            return defer.promise;
        });
    }
}

module.exports = Manager;


function _emptyCriteria(criteria={}) {
    return Object.keys(criteria).length === 0;
}

function _makeDefaultAttributes(Model, record) {
    let schema = Model.definition;

    let field, definition;
    Object.keys(schema).map((key) => {
        definition = schema[key];
        if(record[key] !== undefined) return;
        if(!definition.defaultsTo) return;
        record[key] = _get(definition.defaultsTo);
    });

    return record;
}

function _get(defaultsTo) {
    if(typeof defaultsTo === 'function') {
        return defaultsTo();
    }
    return defaultsTo;
}

function _getIdentityFields(Model, record, identityFields=[]) {

    /*
     * Definition holds the schema
     * inforamtion of your model.
     */
    let schema = Model.definition;

    let definition;
    /*
     * Collect all unique keys in schema.
     * We can check record and see if we have
     * any present that we did not specify in
     * our `identityFields`.
     * If we do, we are good.
     */
    Object.keys(schema).map((key) => {
        definition = schema[key];
        if(definition.unique) {
            identityFields.push(key);
        }
    });

    return identityFields;
}
