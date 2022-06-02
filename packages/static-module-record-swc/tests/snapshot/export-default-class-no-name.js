// @ts-nocheck
export default new StaticModuleRecord({
    bindings: [
        {
            export: "default"
        }
    ],
    needsImportMeta: false,
    initialize: function(_, import_meta, import_) {
        _.default = class {
        };
    }
});
