/*jshint esversion:6, node:true*/
'use strict';
const fsx = require('fs-extra');
const path = require('path');
/**
 * dataSync: Sincronize models after file updates.
 *
 * Commands execute in the context of the app,
 * meaning this === app.
 */
module.exports = function dataSync(event) {
    const context = this;
    const _logger = context.getLogger('data-sync');

    if (!event.entity) {
        _logger.warn('Ignoring event, we dont have valid "entity"');
        return;
    }

    if (!event.filepath) {
        _logger.warn('Ignoring event, we dont have valid "filepath"');
        return;
    }

    //TODO: we could validate event.filepath and a) make sure exists b) it's valid type.
    const moduleid = dataManager.moduleid;
    const dataManager = context.datamanager;

    const moveKeypath = `${moduleid}.${event.origin}.moveAfterDone`;
    const historyKeypath = `${moduleid}.${event.origin}.historyPath`;
    const moveAfterDone = context.config.get(moveKeypath, event.moveAfterDone);

    dataManager.importFileAsModels(event.entity, event.filepath).then(records => {

        let errors = dataManager.consumeErrorsFor(event.entity);

        if (errors && errors.length) {
            _logger.error('DataManager.importFileAsModels returned with %s error(s).', errors.length);
            return errors.map(err => _logger.error(err.message));
        } else {
            _logger.info('sync completed for entity %s', event.entity);
            _logger.info(JSON.stringify(records, null, 4));
        }

        //TODO: we should clean up after copy. Should it be handled by datamanager?!
        if (moveAfterDone) {
            const dest = context.config.get(historyKeypath, event.historyPath);

            fsx.mkdirp(dest).then(_ => {
                const target = getTargetFilename(event.filepath);
                return fsx.move(event.filepath, target);
            }).catch(err => {
                _logger.error('Error archiving our file: %s', event.filepath);
                _logger.error(err);
            });
        }
    }).catch(err => {
        _logger.error('Error while importing file as models.');
        _logger.error('Error message: %s\n%s', err.message, err.stack);
    });
};

function getTargetFilename(filepath) {
    const date = Date.now();
    const dirname = path.dirname(filepath);
    let filename = path.basename(filepath);
    return path.join(dirname, `${date}-${filename}`);
}