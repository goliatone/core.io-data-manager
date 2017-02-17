/*jshint esversion:6, node:true*/
'use strict';

const Manager = require('./manager');

module.exports.init = function(app, config){

    app.getLogger('data').debug('data-manager:init');

    return new Promise(function(resolve, reject){
        app.getLogger('data').debug('data-manager:promise');

        app.resolve('persistence').then((orm) => {
            app.getLogger('data').debug('registering data-manager');

            config.modelProvider = function(identity) {
                return app.persistence.getModel(identity);
            };

            let dataManager = new Manager(config);

            resolve(dataManager);
        });
    });
};
