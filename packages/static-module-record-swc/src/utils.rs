use swc_common::DUMMY_SP;
use swc_plugin::ast::*;
use swc_plugin::utils::private_ident;

pub fn import_meta() -> Ident {
    private_ident!("import_meta")
}

pub fn module_environment_record() -> Ident {
    private_ident!("module_environment_record")
}

pub fn dynamic_import() -> Ident {
    private_ident!("dynamic_import")
}

pub fn key_value(key: JsWord, expr: Expr) -> PropOrSpread {
    PropOrSpread::Prop(Box::new(
        KeyValueProp {
            key: Ident::new(key, DUMMY_SP).into(),
            value: Box::new(expr),
        }
        .into(),
    ))
}

pub fn param(id: Ident) -> Param {
    Param {
        span: DUMMY_SP,
        decorators: vec![],
        pat: BindingIdent { id, type_ann: None }.into(),
    }
}

pub fn str_lit(value: JsWord) -> Expr {
    Str {
        span: DUMMY_SP,
        value: value.into(),
        raw: None,
    }
    .into()
}
