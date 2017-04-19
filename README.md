## core.io Data Manager


### Known Issues
If we are doing an `updateOrCreate` and no `identityFields` are present in the POJO used to hydrate the model then we won't be able to find the record.

One way to get around this would be to collect all unique attributes in the model definition and use any of those.


Model definitions in JSON files for data.sync must have all [required] properties defined. `defaultsTo` is not being applied.

Validation errors impede a record from being created.
