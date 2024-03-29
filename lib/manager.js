'use strict';

const fs = require('fs');
const extend = require('gextend');
const { extname } = require('path');
const EventEmitter = require('events');

const CSVParser = require('./parsers/csv');
const CSVExporter = require('./exporters/csv');

const JSONParser = require('./parsers/json');
const JSONExporter = require('./exporters/json');

const DEFAULTS = {
    autoinitialize: true,
    /**
     * We can introduce a cool down period
     * after we have imported a number X of
     * items. Every time we reach this buffer
     * counter we trigger a delay of
     * `delayAfterItemBatch` milliseconds.
     */
    numberOfItemsBeforeDelay: -1,
    /**
     * Number in milliseconds that we would
     * wait before resuming our importing of
     * items.
     * Every X items wait `delayAfterItemBatch`
     * before resuming importing.
     */
    delayAfterItemBatch: 1000,
    /**
     * Number in milliseconds that we wait
     * between each individual item we import.
     */
    delayBetweenItems: -1,
    importOptions: {
        truncate: false,
        identityFields: ['id', 'uuid'],
        strict: true,
        updateMethod: 'updateOrCreate',
        getIdentityFields: _getIdentityFields,
    },
    modelProvider: function(identity) {
        return Promise.reject(new Error('Need to implement'));
    },
    createFileNameFor: function(identity, type) {
        const date = Date.now();
        return `${date}-${identity}.${type}`;
    },
    pluginProvider: function(plugin) {
        const resolve = require('path').resolve;
        return require(resolve(plugin));
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
        this._importingEntities = {};

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

        return Promise.resolve(this._parsers[type](content, options)).then((results = []) => {

            if (!Array.isArray(results)) {
                if (typeof results === 'object') results = [results];
                else throw new Error('Ensure imported content has right format.');
            }

            results.reverse();
            results.map(res => this.emit('record.' + type, res));
            this.emit('records.' + type, results);

            return results;
        });
    }

    importFile(filename, options = {}) {
        return new Promise((resolve, reject) => {
            fs.readFile(filename, (err, content) => {
                if (err) {
                    this.logger.error('importFile %s error', filename);
                    return reject(err);
                }
                content = content.toString();

                let type = extname(filename).replace('.', '');

                if (options && options.type) type = options.type;

                try {
                    resolve(this.import(type, content, options));
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    importAsModels(identity, type, content, options = {}) {
        return this.import(type, content, options).then(results => {
            return this._importModel(identity, results, options);
        });
    }

    importFileAsModels(identity, filename, options) {
        return this.importFile(filename, options).then(results => {
            return this._importModel(identity, results, options);
        });
    }

    /**
     * Returns a list of identities for the Models
     * currently being imported.
     * @returns {Array}
     */
    currentlyBeingImported() {
        return Object.keys(this._importingEntities).reduce((acc, key) => {
            if (this._importingEntities[key]) acc.push(key);
            return acc;
        }, []);
    }

    /**
     * Returns true if we are currently importing a model.
     * @returns {Boolean}
     */
    get importing() {
        return !!Object.values(this._importingEntities).find(e => e === true);
    }

    _importingEntity(identity, importing = true) {
        if (!this._importingEntities) this._importingEntities = {};
        this._importingEntities[identity] = importing;
    }

    _importModel(identity, items, options = {}) {
        options = extend({}, this.importOptions, options);

        if (!items) items = [];
        if (typeof items === 'object' && !Array.isArray(items)) items = [items];

        items = this._applyTransform(identity, items, options);

        let self = this;
        let _logger = this.logger;

        //A simple boolean flag is not enough, we want to manage
        //multiple entities being imported at the same time.
        this._importingEntity(identity);

        return this.modelProvider(identity).then(Model => {
            if (!Model) return Promise.reject(new Error('Model not found'));

            let method = options.truncate ? 'create' : options.updateMethod;

            async function iterate(records, options, output = [], errors = []) {
                let record = records.pop();

                if (!record) {
                    if (errors && errors.length) self.addErrors(identity, errors);
                    self._importingEntity(identity, false);
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
                 * behavior to `Model.create`.
                 * Also, if some of those fields are
                 * unique then we ensure we can do
                 * a `updateOrCreate`.
                 */
                record = _makeDefaultAttributes(Model, record);

                /*
                 * Currently we are retrieving all identity fields
                 * and querying multiple keys, e.g.:
                 * {id:<v>, uuid:<v>, email: <v>}
                 *
                 * This might not be effective and also it
                 * might not be what we want.
                 *
                 * Since using ID's can be problematic due to
                 * casting (any field for that matter) we might
                 * want to have more control in a case by case
                 * basis.
                 */
                let identityFields = options.identityFields.concat();
                identityFields = options.getIdentityFields(Model, record, identityFields);

                /*
                 * A model's identityFields are all
                 * unique attributes. If we are updating
                 * a record, we might have changed one of
                 * those before- e.g. email.
                 * We use an `or` query to get around
                 * this.
                 */
                let criteria = self.buildCriteria(Model, record, identityFields);

                /*
                 * We need to have a way to perform a
                 * updateOrCreate;
                 */
                if (_emptyCriteria(criteria)) {
                    _logger.warn('We dont have a criteria...');
                    _logger.warn('%j', Object.keys(Model.attributes));
                    _logger.warn('Model keys: %j', Object.keys(Model));
                    //TODO: Not sure if this is the best way to go along?
                    if (o.truncate) {
                        o.truncate = false;
                        updateStrategy = 'create';
                    }
                }

                /**
                 * If we have a cool off period after importing X
                 * items then we do delay.
                 */
                if (_itemTriggersBatchDelay(options, output.length)) {
                    _logger.info('Cooling off period, waiting for ', options.delayAfterItemBatch);
                    await delay(options.delayAfterItemBatch);
                }

                /**
                 * We can introduce a wait period between each
                 * individual.
                 */
                if (options.delayBetweenItems > 0) {
                    await delay(options.delayBetweenItems);
                }

                let args = o.truncate ? [record] : [criteria, record];

                return Model[updateStrategy].apply(Model, args).then(record => {
                    output.push(record);
                    return iterate(records, options, output, errors);
                }).catch(err => {
                    let errorMessage = [
                        '_importModel.iterate error',
                        '%s.%s failed: %s',
                        'DataManager does not know what to do with this error.',
                        'They will be bubbled up, you should handle them.',
                        'The record being processed:',
                        '%j',
                    ].join('\n');

                    _logger.error(errorMessage, identity, updateStrategy, err.message && err.message.toString(), record);
                    _logger.info('Query was:');
                    _logger.info('%s.%s(%j, %j)', identity, updateStrategy, criteria, record);

                    errors.push(self.wrapError(record, identity, updateStrategy, criteria, err));
                    return iterate(records, options, output, errors);
                });
            }

            if (options.truncate) {
                return Model.destroy({}).then(_ => iterate(items, options));
            } else return iterate(items, options);
        }).then(records => {
            return records;
        });
    }

    exportModels(identity, query = {}, type = 'json', options = {}) {

        return this.modelProvider(identity).then(Model => {
            var orm = Model.find(query.criteria || {});

            if (query.populate) {
                if (typeof query.populate === 'string' || Array.isArray(query.populate)) {
                    orm.populate(query.populate);
                } else if (typeof query.populate === 'object') {
                    if (query.populate.name) {
                        orm.populate(query.populate.name, query.populate.criteria);
                    }
                }
            }

            if (query.skip) orm.skip(query.skip);
            if (query.limit) orm.skip(query.limit);
            if (query.sort) orm.sort(query.sort);

            return orm.then(models => {
                return this.export(type, models, options);
            });
        });
    }

    exportModelsToFile(identity, query = {}, type = 'json', options = {}) {
        const filename = options.filename || this.createFileNameFor(identity, type);
        this.logger.info('filename:', filename);
        return this.exportModels(identity, query, type, options).then(output => {
            return new Promise((resolve, reject) => {
                //TODO: Maybe use a createWriteStream?
                fs.writeFile(filename, output, options.fs || 'utf8', function(err) {
                    if (err) reject(err);
                    else resolve(filename);
                });
            });
        });
    }

    _applyTransform(identity, items, options) {
        this.logger.info('apply transform "%s": ----', identity, options);

        if (options.transform) {
            if (typeof options.transform === 'string') {
                try {
                    options.transform = this.pluginProvider(options.transform);
                } catch (error) {
                    this.logger.error('Error importing transform plugin');
                    this.logger.error(error.message);
                }
            }

            if (typeof options.transform === 'function') {
                items = options.transform(items, options);
            }
        }

        return items;
    }

    buildCriteria(Model, record, identityFields = []) {

        if (!identityFields || identityFields.length === 0) {
            throw new Error('Build Criteria: need identity fields');
        }

        let criteria = { or: [] };

        const isEmpty = v => v === undefined || v === null || v === "";

        const expressionFromField = field => {
            if (Model.attributes.hasOwnProperty(field) === false) {
                throw new Error(`Build Criteria: model has no field ${field}`);
            }

            let value = _castField(Model, record, field);

            if (isEmpty(value)) return undefined;

            let expression = {};
            expression[field] = value;

            return expression;
        };

        if (identityFields.length === 1) {
            return expressionFromField(identityFields[0]);
        }

        identityFields.map(field => {
            criteria.or.push(expressionFromField(field));
        });

        /**
         * Filter out invalid criteria values
         */
        criteria.or = criteria.or.filter(Boolean);

        return criteria;
    }

    wrapError(record, identity, updateStrategy, criteria, src = {}) {
        let error = new DataManagerError(src.message, identity, updateStrategy, criteria, src);
        error.record = record;
        return error;
    }
}

module.exports = Manager;

async function delay(t = 100) {
    return new Promise((resolve) => {
        setTimeout(resolve, t);
    });
}

function _itemTriggersBatchDelay(options = {}, itemCount = 0) {
    if (typeof options.numberOfItemsBeforeDelay !== 'number') return false;
    if (options.numberOfItemsBeforeDelay === -1) return false;
    return (options.numberOfItemsBeforeDelay % itemCount) === 0;
}

function _emptyCriteria(criteria = {}) {
    return Object.keys(criteria).length === 0;
}

function _makeDefaultAttributes(Model, record) {
    let schema = Model.definition;

    let field, definition;
    Object.keys(schema).map((key) => {
        definition = schema[key];
        if (record[key] !== undefined) return;
        if (!definition.defaultsTo) return;
        record[key] = _get(definition.defaultsTo);
    });

    return record;
}

function _get(defaultsTo) {
    if (typeof defaultsTo === 'function') {
        return defaultsTo();
    }
    return defaultsTo;
}

/**
 * Get the fields from a model attributes that we will use
 * to make our query's criteria.
 *
 * This method will iterate over the model definition and append
 * those unique attributes not already present in the passed in
 * `identityFields`.
 *
 * @param       {Object} Model               Waterline collection
 * @param       {Object} record              Instance attributes
 * @param       {Array}  [identityFields=[]] Default fields
 * @return      {Array}                     Complete list of identity fields
 */
function _getIdentityFields(Model, record, identityFields = []) {
    console.log('using DEFAULT FUNCTION to extract identity fields', identityFields);
    /*
     * Definition holds the schema
     * information of your model.
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
    Object.keys(schema).map(key => {
        definition = schema[key];
        if (definition.unique) {
            if (!identityFields.includes(key)) {
                identityFields.push(key);
            }
        }
    });

    return identityFields;
}

/**
 * If we pass an ID as a number but the schema
 * has id defined as text/string we will fail
 * to match the record. This is a quick fix.
 *
 * This does not solve the issue of references,
 * e.g. `{id:1, user:1}`.
 *
 * @param       {Object} Model               Waterline collection
 * @param       {Object} record              Instance attributes
 * @return      {Mixed}        Value after casting
 */
function _castField(Model, record, field) {
    let value = record[field];

    if (value === null || value === undefined) {
        return value;
    }

    let type = Model.attributes[field].type;

    if (type === 'text' || type === 'string') {
        value = '' + value;
        record[field] = value;
    }

    return value;
}

class DataManagerError extends Error {
    constructor(message, identity, updateStrategy, criteria, source) {
        super(message);
        this.identity = identity;
        this.updateStrategy = updateStrategy;
        this.criteria = criteria;
        this.source = source;
        this.id = `error_${identity}_${Date.now().toString(36)}`;
    }
}
