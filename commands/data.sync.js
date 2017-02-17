/*jshint esversion:6, node:true*/
'use strict';

const exists = require('fs-exists-promised');

/**
 * dataSync: Sincronize models after file updates.
 *
 * Commands execute in the context of the app,
 * meaning this === app.
 */
module.exports = function dataSync(event){
    var app = this;

    app.getLogger('data.sync').info('dataSync: %s', JSON.stringify(event, null, 4));

    if(!event.entity){
        app.getLogger('data.sync').warn('Ignoring event, we dont have valid "entity"');
        return;
    }

    if(!event.filepath){
        app.getLogger('data.sync').warn('Ignoring event, we dont have valid "filepath"');
        return;
    }

    //TODO: we could validate event.filepath and a) make sure exists b) it's valid type.

    var moveAfterDone = app.config.get('filesync.' + event.origin + '.moveAfterDone', false);


    app.datamanager.importFileAsModels(event.entity, event.filepath).then((records)=>{
        app.getLogger('data.sync').info('sync completed for entity %s', event.entity);
        app.getLogger('data.sync').info(JSON.stringify(records, null, 4));

        //TODO: we should clean up after copy. Should it be handled by datamanager?!
        if(moveAfterDone) {
            var dest = app.config.get('filesync.' + event.origin + '.historyPath', false);
            //check if target path exists
            exists(dest).then(function(){
                //actually move the contens to a history folder
            }).catch(function(){
                //for now, just bleh
            });
        }
    }).catch((err)=> {
        app.getLogger('data.sync').error('Error while importing file as models.');
        app.getLogger('data.sync').error('Error message: %s\n%s', err.message, err.stack);
    });
};
