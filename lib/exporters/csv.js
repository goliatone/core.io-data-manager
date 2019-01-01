/*jshint esversion:6, node:true*/
'use strict';

const stringifier = require('csv-stringify');

class CSVExporter {
    constructor(manager) {
        manager.exporter('csv', this.export.bind(this, ','));
        manager.exporter('tsv', this.export.bind(this, '\t'));
    }

    export (delimiter, records, options = {}) {
        options.delimiter = options.delimiter || delimiter;

        if (!options.header) options.header = true;

        return new Promise((resolve, reject) => {
            //TODO: we should iterate over records and make sure we don't
            //have populated relationships, and if we do, then show just the
            //id
            stringifier(records, options, function(err, out) {
                if (err) reject(err);
                resolve(out);
            });
        });
    }
}
module.exports = CSVExporter;