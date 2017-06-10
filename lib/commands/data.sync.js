/*jshint esversion:6, node:true*/
'use strict';

const exists = require('fs-exists-promised');

/**
 * dataSync: Sincronize models after file updates.
 *
 * Commands execute in the context of the app,
 * meaning this === app.
 */
module.exports = function dataSync(event) {
    let context = this;
    let _logger = context.getLogger('data-sync');

    if (!event.entity) {
        _logger.warn('Ignoring event, we dont have valid "entity"');
        return;
    }

    if (!event.filepath) {
        _logger.warn('Ignoring event, we dont have valid "filepath"');
        return;
    }

    //TODO: we could validate event.filepath and a) make sure exists b) it's valid type.
    let dataManager = context.datamanager;
    let moduleid = dataManager.moduleid;
    let moveAfterDone = context.config.get(`${moduleid}.${event.origin}.moveAfterDone`, false);

    dataManager.importFileAsModels(event.entity, event.filepath).then((records) => {

        let errors = dataManager.consumeErrorsFor(event.entity);

        if (errors && errors.length) {
            _logger.error('DataManager.importFileAsModels returned with %s error(s).', errors.length);
            return errors.map((err) => _logger.error(err.message));
        } else {
            _logger.info('sync completed for entity %s', event.entity);
            _logger.info(JSON.stringify(records, null, 4));
        }

        //TODO: we should clean up after copy. Should it be handled by datamanager?!
        if (moveAfterDone) {
            var dest = context.config.get(`filesync.${event.origin}.historyPath`, false);
            //check if target path exists
            exists(dest).then(function() {
                //actually move the contens to a history folder
            }).catch(function() {
                //for now, just bleh
            });
        }
    }).catch((err) => {
        _logger.error('Error while importing file as models.');
        _logger.error('Error message: %s\n%s', err.message, err.stack);
    });
};
