// @ts-nocheck
export default (StaticModuleRecord)=>new StaticModuleRecord({
        bindings: [],
        needsImportMeta: true,
        initialize: function(module_environment_record, import_meta, dynamic_import) {
            import_meta;
            import_meta();
            import_meta['url'];
            alert(import_meta.url);
        }
    });
