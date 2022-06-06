// @ts-nocheck
export default {
    bindings: [
        {
            export: "*",
            from: 'mod'
        },
        {
            export: "*",
            as: "x2",
            from: 'mod2'
        },
        {
            export: "default",
            from: 'mod3'
        },
        {
            export: "default",
            as: "x3",
            from: 'mod3'
        },
        {
            export: 'some export',
            as: "x4",
            from: 'mod3'
        },
        {
            export: "x5",
            from: 'mod3'
        }
    ],
    initialize: function(_, import_meta, import_) {}
};
