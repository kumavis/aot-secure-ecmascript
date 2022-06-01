// @ts-nocheck
export default new StaticModuleRecord({
    bindings: [
        {
            export: "named"
        },
        {
            export: "T"
        }
    ],
    needsImportMeta: false,
    initialize: function(lexical_scope, import_meta, import_) {
        function named() {}
        lexical_scope.named = named;
        class T {
        }
        lexical_scope.T = T;
    }
});
