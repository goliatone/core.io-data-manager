/*jshint esversion:6, node:true*/
'use strict';
const fsx = require('fs-extra');
const path = require('path');
/**
 * dataSync: Sincronize models after file updates.
 *
 * Commands execute in the context of the app,
 * meaning this === app.
 *
 * @param {Object} event
 * @param {String} event.entity
 * @param {String} event.origin
 * @param {String} event.action
 * @param {String} event.filepath
 * @param {String} event.errorsPath
 * @param {String} event.historyPath
 * @param {String} event.moveAfterDone
 *
 * @returns {Void}
 */
module.exports = function dataSync(event) {
    const context = event.context;
    const logger = context.getLogger('data-sync');

    if (!event.entity) {
        return logger.warn('Ignoring event, we dont have valid "entity"');
    }

    if (!event.filepath) {
        return logger.warn('Ignoring event, we dont have valid "filepath"');
    }

    //TODO: we could validate event.filepath and a) make sure exists b) it's valid type.
    const dataManager = context.datamanager;
    const moduleid = dataManager.moduleid;

    /**
     * Should we move the file when we finish data sync?
     */
    const moveKeypath = `${moduleid}.${event.origin}.moveAfterDone`;

    /**
     * Path to move errored files
     */
    const errorsKeypath = `${moduleid}.${event.origin}.errorsPath`;

    /**
     * Path to move successful files
     */
    const historyKeypath = `${moduleid}.${event.origin}.historyPath`;


    const moveAfterDone = context.config.get(moveKeypath, event.moveAfterDone);

    dataManager.importFileAsModels(event.entity, event.filepath).then((records = []) => {
        logger.info('sync completed for entity %s', event.entity);

        let completionCommand = 'data.sync.done';
        let dest = context.config.get(historyKeypath, event.historyPath);
        let errors = dataManager.consumeErrorsFor(event.entity);

        const hasErrors = errors && errors.length;

        if (hasErrors) {
            logger.error('DataManager.importFileAsModels returned with %s error(s).', errors.length);
            /**
             * Move our source sync file to the error directory
             */
            dest = context.config.get(errorsKeypath, event.errorsPath);
            completionCommand = 'data.sync.error';
        }

        moveSourceFiles(moveAfterDone, dest, event.filepath);

        if (context.hasCommand(completionCommand)) {
            context.emit(completionCommand, {
                id: event.id,
                errors,
                records,
                parameters: getParameters(event),
                $meta: event.$meta || {},
            });
        }

    }).catch(err => {
        logger.error('Error while importing file as models.');
        logger.error('Error message: %s\n%s', err.message, err.stack);
    });

    const moveSourceFiles = (move, dest, filepath) => {
        if (!move) return;
        fsx.mkdirp(dest).then(_ => {
            const target = getTargetFilename(filepath, dest);
            return fsx.move(filepath, target);
        }).catch(err => {
            logger.error('Error archiving our file: %s', filepath);
            logger.error(err);
        });
    };
};

function getTargetFilename(filepath, target) {
    const date = Date.now();
    const filename = path.basename(filepath);
    return path.join(target, `${date}-${filename}`);
}


function getParameters(src) {
    const attributes = [
        'entity',
        'origin',
        'action',
        'filepath',
        'errorsPath',
        'historyPath',
        'moveAfterDone'
    ];
    return attributes.reduce((out, key) => {
        out[key] = src[key];
        return out;
    }, {});
}
