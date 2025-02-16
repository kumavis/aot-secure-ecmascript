import { ModuleSource } from './ModuleSource.js'
import type {
    ImportHook,
    ImportMetaHook,
    ModuleHandler,
    ModuleNamespace,
    VirtualModuleRecord,
    VirtualModuleRecordExecuteContext,
} from './types.js'
import {
    all,
    ambiguous,
    empty,
    namespace,
    NormalCompletion,
    PromiseCapability,
    ThrowCompletion,
    type Completion,
    type ModuleExportEntry,
    type ModuleImportEntry,
} from './utils/spec.js'
import { normalizeBindingsToSpecRecord, normalizeVirtualModuleRecord } from './utils/normalize.js'
import { assertFailed, opaqueProxy } from './utils/assert.js'
import { defaultImportHook } from './Evaluators.js'
import { createTask, type Task } from './utils/async-task.js'

export let imports: <T extends ModuleNamespace = any>(specifier: Module<T>, options?: ImportCallOptions) => Promise<T>
/** @internal */
export let setParentGlobalThis: (module: Module, global: object) => void
/** @internal */
export let setParentImportHook: (module: Module, handler: ImportHook) => void
/** @internal */
export let setParentImportMetaHook: (module: Module, handler: ImportMetaHook) => void

export class Module<T extends ModuleNamespace = any> {
    // The constructor is equivalent to ParseModule in SourceTextModuleRecord
    // https://tc39.es/ecma262/#sec-parsemodule
    constructor(moduleSource: ModuleSource<T> | VirtualModuleRecord, handler: ModuleHandler) {
        if (typeof moduleSource !== 'object') throw new TypeError('moduleSource must be an object')
        // impossible to create a ModuleSource instance
        if (moduleSource instanceof ModuleSource) assertFailed('ModuleSource instance cannot be created')
        const module = normalizeVirtualModuleRecord(moduleSource)

        if (handler === null) throw new TypeError('handler must not be null')
        let importHook: ImportHook | undefined
        let importMetaHook: ImportMetaHook | undefined
        if (typeof handler === 'object') {
            importHook = handler.importHook
            if (typeof importHook !== 'function' && importHook !== undefined)
                throw new TypeError('importHook must be a function')
            importMetaHook = handler.importMetaHook
            if (typeof importMetaHook !== 'function' && importMetaHook !== undefined)
                throw new TypeError('importMetaHook must be a function')
        }

        this.#VirtualModuleSource = moduleSource
        this.#Execute = module.execute
        this.#NeedsImport = module.needsImport
        this.#NeedsImportMeta = module.needsImportMeta
        this.#HasTLA = !!module.isAsync

        this.#ImportHook = importHook
        this.#ImportMetaHook = importMetaHook
        this.#HandlerValue = handler

        const { importEntries, indirectExportEntries, localExportEntries, requestedModules, starExportEntries } =
            normalizeBindingsToSpecRecord(module.bindings)
        this.#ImportEntries = importEntries
        this.#IndirectExportEntries = indirectExportEntries
        this.#LocalExportEntries = localExportEntries
        this.#RequestedModules = requestedModules
        this.#StarExportEntries = starExportEntries
    }
    get source(): ModuleSource | VirtualModuleRecord | null {
        return this.#VirtualModuleSource
    }
    //#region ModuleRecord fields https://tc39.es/ecma262/#table-module-record-fields
    /** first argument of execute() */
    #Environment: object | undefined
    /** result of await import(mod) */
    #Namespace: ModuleNamespace | undefined
    //#endregion

    //#region VirtualModuleRecord fields
    // *this value* when calling #Execute.
    #VirtualModuleSource: VirtualModuleRecord
    #Execute: VirtualModuleRecord['execute']
    #NeedsImportMeta: boolean | undefined
    #NeedsImport: boolean | undefined
    #ContextObject: VirtualModuleRecordExecuteContext | undefined
    #ImportHook: ImportHook | undefined
    #ImportMetaHook: ImportMetaHook | undefined
    #HandlerValue: ModuleHandler
    /** the global environment this module binds to */
    #GlobalThis: object = globalThis
    #ParentImportHook: ImportHook = defaultImportHook
    #ParentImportMetaHook: ImportMetaHook | undefined
    /** imported module cache */
    #ImportEntries: ModuleImportEntry[]
    #LocalExportEntries: ModuleExportEntry[]
    #IndirectExportEntries: ModuleExportEntry[]
    #StarExportEntries: ModuleExportEntry[]
    /** Where local export stored */
    #LocalExportedValues = new Map<string, unknown>()
    /** Callback to update live exports */
    #non_std_ExportCallback = new Map<string, Set<(newValue: any) => void>>()
    //#endregion

    //#region VirtualModuleRecord methods
    #non_std_AddLiveExportCallback(name: string, callback: (newValue: any) => void) {
        if (!this.#non_std_ExportCallback.has(name)) this.#non_std_ExportCallback.set(name, new Set())
        this.#non_std_ExportCallback.get(name)!.add(callback)
    }
    //#endregion

    //#region ModuleRecord methods https://tc39.es/ecma262/#table-abstract-methods-of-module-records
    // https://tc39.es/ecma262/#sec-getexportednames
    #GetExportedNames(exportStarSet: Module[] = []): string[] {
        const module = this
        if (!(module.#Status !== ModuleStatus.new)) assertFailed()
        if (exportStarSet.includes(module)) return []
        exportStarSet.push(module)
        const exportedNames: string[] = []
        for (const e of module.#LocalExportEntries) {
            if (!(e.ExportName !== null)) assertFailed()
            exportedNames.push(e.ExportName)
        }
        for (const e of module.#IndirectExportEntries) {
            if (!(e.ExportName !== null)) assertFailed()
            exportedNames.push(e.ExportName)
        }
        for (const e of module.#StarExportEntries) {
            if (!(e.ModuleRequest !== null)) assertFailed()
            const requestedModule = Module.#GetImportedModule(module, e.ModuleRequest)
            const starNames = requestedModule.#GetExportedNames(exportStarSet)
            for (const n of starNames) {
                if (n === 'default') continue
                if (exportedNames.includes(n)) continue
                exportedNames.push(n)
            }
        }
        return exportedNames
    }
    // https://tc39.es/ecma262/#sec-resolveexport
    #ResolveExport(
        exportName: string,
        resolveSet: { module: Module; exportName: string }[] = [],
    ): typeof ambiguous | { module: Module; bindingName: string | typeof namespace } | null {
        const module = this
        if (!(module.#Status !== ModuleStatus.new)) assertFailed()
        for (const r of resolveSet) {
            if (module === r.module && exportName === r.exportName) {
                // Assert: This is a circular import request.
                return null
            }
        }
        resolveSet.push({ module, exportName })
        for (const e of module.#LocalExportEntries) {
            if (exportName === e.ExportName) {
                // if (!(e.LocalName !== null)) assertFailed()
                // return { module, bindingName: e.LocalName }
                return { module, bindingName: e.ExportName }
            }
        }
        for (const e of module.#IndirectExportEntries) {
            if (exportName === e.ExportName) {
                if (!(e.ModuleRequest !== null)) assertFailed()
                const importedModule = Module.#GetImportedModule(module, e.ModuleRequest)
                if (e.ImportName === all) {
                    // Assert: module does not provide the direct binding for this export.
                    return { module: importedModule, bindingName: namespace }
                } else {
                    if (!(typeof e.ImportName === 'string')) assertFailed()
                    return importedModule.#ResolveExport(e.ImportName, resolveSet)
                }
            }
        }
        if (exportName === 'default') {
            // Assert: A default export was not explicitly provided by this module.
            // Note: A default export cannot be provided by an export * from "mod" declaration.
            return null
        }
        let starResolution: null | { module: Module; bindingName: string | typeof namespace } = null
        for (const e of module.#StarExportEntries) {
            if (!(e.ModuleRequest !== null)) assertFailed()
            const importedModule = Module.#GetImportedModule(module, e.ModuleRequest)
            let resolution = importedModule.#ResolveExport(exportName, resolveSet)
            if (resolution === ambiguous) return ambiguous
            if (resolution !== null) {
                if (starResolution === null) starResolution = resolution
                else {
                    // Assert: There is more than one * import that includes the requested name.
                    if (resolution.module !== starResolution.module) return ambiguous
                    if (
                        (resolution.bindingName === namespace && starResolution.bindingName !== namespace) ||
                        (resolution.bindingName !== namespace && starResolution.bindingName === namespace)
                    )
                        return ambiguous
                    if (
                        typeof resolution.bindingName === 'string' &&
                        typeof starResolution.bindingName === 'string' &&
                        resolution.bindingName !== starResolution.bindingName
                    ) {
                        return ambiguous
                    }
                }
            }
        }
        return starResolution
    }
    #LoadRequestedModules(HostDefined: Task) {
        const module = this
        const pc = PromiseCapability<void>()
        const state: GraphLoadingState = {
            IsLoading: true,
            PendingModulesCount: 1,
            Visited: [],
            PromiseCapability: pc,
            HostDefined,
        }
        Module.#InnerModuleLoading(state, module)
        return pc.Promise
    }
    static #InnerModuleLoading(state: GraphLoadingState, module: Module) {
        if (!state.IsLoading) assertFailed()
        if (module.#Status === ModuleStatus.new && !state.Visited.includes(module)) {
            state.Visited.push(module)
            const requestedModulesCount = module.#RequestedModules.length
            state.PendingModulesCount = state.PendingModulesCount + requestedModulesCount
            for (const required of module.#RequestedModules) {
                const record = module.#LoadedModules.get(required)
                if (record) {
                    Module.#InnerModuleLoading(state, record)
                } else {
                    Module.#LoadImportedModule(module, required, state.HostDefined, state)
                }
                if (!state.IsLoading) return
            }
        }
        if (!(state.PendingModulesCount >= 1)) assertFailed()
        state.PendingModulesCount = state.PendingModulesCount - 1
        if (state.PendingModulesCount === 0) {
            state.IsLoading = false
            for (const loaded of state.Visited) {
                if (loaded.#Status === ModuleStatus.new) loaded.#Status = ModuleStatus.unlinked
            }
            state.PromiseCapability.Resolve()
        }
    }
    static #ContinueModuleLoading(state: GraphLoadingState, moduleCompletion: Completion<Module>) {
        if (!state.IsLoading) return
        if (moduleCompletion.Type === 'normal') Module.#InnerModuleLoading(state, moduleCompletion.Value)
        else {
            state.IsLoading = false
            state.PromiseCapability.Reject(moduleCompletion.Value)
        }
    }
    //#endregion

    //#region CyclicModuleRecord fields https://tc39.es/ecma262/#sec-cyclic-module-records
    #Status = ModuleStatus.new
    #EvaluationError: unknown | empty = empty
    #DFSIndex: number | empty = empty
    #DFSAncestorIndex: number | empty = empty
    #RequestedModules: string[]
    #LoadedModules = new Map<string, Module>()
    #LoadingModules = new Map<string, Set<GraphLoadingState | PromiseCapability<ModuleNamespace>>>()
    #LoadStates = new Set<GraphLoadingState | PromiseCapability<ModuleNamespace>>()
    #CycleRoot: Module | undefined
    #HasTLA: boolean
    #AsyncEvaluation = false
    #__AsyncEvaluationPreviouslyTrue = false
    #TopLevelCapability: PromiseCapability<void> | undefined
    #AsyncParentModules: Module[] = []
    #PendingAsyncDependencies: number | empty = empty
    //#endregion

    //#region CyclicModuleRecord methods https://tc39.es/ecma262/#table-cyclic-module-methods
    // https://tc39.es/ecma262/#sec-source-text-module-record-initialize-environment
    #InitializeEnvironment() {
        const module = this
        for (const e of module.#IndirectExportEntries) {
            if (!(e.ExportName !== null)) assertFailed()
            const resolution = module.#ResolveExport(e.ExportName)
            if (resolution === null || resolution === ambiguous) {
                throw new SyntaxError(`Module '${e.ModuleRequest}' does not provide an export ${e.ExportName}`)
            }
        }

        // Assert: All named exports from module are resolvable.

        const env = { __proto__: null }
        module.#ContextObject = createContextObject()
        module.#Environment = env

        const propertiesToBeDefined: PropertyDescriptorMap = {
            __proto__: null!,
        }
        for (const i of module.#ImportEntries) {
            const importedModule = Module.#GetImportedModule(module, i.ModuleRequest)
            // import * as ns from '..'
            if (i.ImportName === namespace) {
                const namespaceObject = Module.#GetModuleNamespace(importedModule)
                propertiesToBeDefined[i.LocalName] = { value: namespaceObject, enumerable: true }
            } else {
                const resolution = importedModule.#ResolveExport(i.ImportName)
                if (resolution === null)
                    throw new SyntaxError(`${i.ModuleRequest} does not provide export ${i.ImportName}`)
                if (resolution === ambiguous)
                    throw new SyntaxError(`${i.ModuleRequest} does not provide an unambiguous export ${i.ImportName}`)
                // import { x } from '...' where x is a "export * as ns from '...'"
                if (resolution.bindingName === namespace) {
                    const namespaceObject = Module.#GetModuleNamespace(resolution.module)
                    propertiesToBeDefined[i.LocalName] = { value: namespaceObject, enumerable: true }
                } else {
                    resolution.module.#non_std_AddLiveExportCallback(i.ImportName, (newValue) => {
                        Object.defineProperty(env, i.LocalName, {
                            value: newValue,
                            configurable: true,
                            enumerable: true,
                        })
                    })

                    if (resolution.module.#LocalExportedValues.has(resolution.bindingName)) {
                        propertiesToBeDefined[i.LocalName] = {
                            configurable: true,
                            enumerable: true,
                            value: resolution.module.#LocalExportedValues.get(resolution.bindingName),
                        }
                    } else {
                        propertiesToBeDefined[i.LocalName] = {
                            get() {
                                throw new ReferenceError(`Cannot access '${i.LocalName}' before initialization`)
                            },
                            configurable: true,
                            enumerable: true,
                        }
                    }
                }
            }
        }

        for (const { ModuleRequest, ExportName, ImportName } of module.#LocalExportEntries) {
            if (!(ModuleRequest === null && typeof ExportName === 'string' && ImportName === null)) assertFailed()
            propertiesToBeDefined[ExportName] = {
                get: () => this.#LocalExportedValues.get(ExportName),
                set: (value) => {
                    this.#LocalExportedValues.set(ExportName, value)
                    this.#non_std_ExportCallback.get(ExportName)?.forEach((callback) => callback(value))
                    return true
                },
                // Note: export property should not be enumerable?
                // but it will crash Chrome devtools. See: https://bugs.chromium.org/p/chromium/issues/detail?id=1358114
                enumerable: true,
            }
        }

        Object.defineProperties(env, propertiesToBeDefined)

        for (const exports of module.#GetExportedNames()) {
            if (module.#ResolveExport(exports) === ambiguous) {
                throw new SyntaxError(`Module has multiple exports named '${exports}'`)
            }
        }
        // TODO: https://github.com/tc39/proposal-compartments/issues/70

        // prevent access to global env until [[ExecuteModule]]
        Object.setPrototypeOf(env, opaqueProxy)
    }
    /** All call to ExecuteModule must use Task.run to keep the call stack continue */
    #ExecuteModule(promise?: PromiseCapability<void>) {
        const execute = this.#Execute
        if (!execute) return
        this.#Execute = undefined

        // prepare context
        this.#ContextObject!.globalThis = this.#GlobalThis as any
        if (this.#NeedsImportMeta) {
            const importMeta = { __proto__: null }
            if (this.#ImportMetaHook) Reflect.apply(this.#ImportMetaHook, this.#HandlerValue, [importMeta])
            else if (this.#ParentImportMetaHook) Reflect.apply(this.#ParentImportMetaHook, undefined, [importMeta])
            this.#ContextObject!.importMeta = importMeta
        }
        if (this.#NeedsImport) {
            this.#ContextObject!.import = async (
                specifier: string | Module<ModuleNamespace>,
                options?: ImportCallOptions,
            ) => {
                const referrer = this
                const promiseCapability = PromiseCapability<ModuleNamespace>()

                let hasModuleInternalSlot = false
                try {
                    ;(specifier as Module).#HandlerValue
                    hasModuleInternalSlot = true
                } catch {}

                if (hasModuleInternalSlot) {
                    const hostDefined = createTask(`import(<module block>)`)
                    Module.#ContinueDynamicImport(promiseCapability, NormalCompletion(specifier as Module), hostDefined)
                } else {
                    specifier = String(specifier)
                    const hostDefined = createTask(`import("${specifier}")`)
                    if (referrer.#LoadedModules.has(specifier)) {
                        Module.#ContinueDynamicImport(
                            promiseCapability,
                            NormalCompletion(referrer.#LoadedModules.get(specifier)!),
                            hostDefined,
                        )
                    } else {
                        Module.#LoadImportedModule(referrer, specifier, hostDefined, promiseCapability)
                    }
                }
                return promiseCapability.Promise as any
            }
        }

        if (!this.#Environment) assertFailed()
        const env = new Proxy(this.#Environment, moduleEnvExoticMethods)

        if (!this.#HasTLA) {
            if (promise) assertFailed()
            const result = Reflect.apply(execute, this.#VirtualModuleSource, [env, this.#ContextObject])
            if (result)
                throw new TypeError(
                    'Due to specification limitations, in order to support Async Modules (modules that use Top Level Await or a Virtual Module that has an execute() function that returns a Promise), the Virtual Module record must be marked with `isAsync: true`. The `isAsync` property is non-standard, and it is being tracked in https://github.com/tc39/proposal-compartments/issues/84.',
                )
        } else {
            if (!promise) assertFailed()
            Promise.resolve(Reflect.apply(execute, this.#VirtualModuleSource, [env, this.#ContextObject])).then(
                promise.Resolve,
                promise.Reject,
            )
        }
    }
    // https://tc39.es/ecma262/#sec-moduledeclarationlinking
    #Link() {
        const module = this
        if (
            ![
                ModuleStatus.unlinked,
                ModuleStatus.linked,
                ModuleStatus.evaluatingAsync,
                ModuleStatus.evaluated,
            ].includes(module.#Status)
        )
            assertFailed()
        const stack: Module[] = []
        try {
            Module.#InnerModuleLinking(module, stack, 0)
        } catch (err) {
            for (const mod of stack) {
                if (!(mod.#Status === ModuleStatus.linking)) assertFailed()
                mod.#Status = ModuleStatus.unlinked
            }
            if (!(module.#Status === ModuleStatus.unlinked)) assertFailed()
            throw err
        }
        if (![ModuleStatus.linked, ModuleStatus.evaluatingAsync, ModuleStatus.evaluated].includes(module.#Status))
            assertFailed()
        if (!(stack.length === 0)) assertFailed()
    }

    // https://tc39.es/ecma262/#sec-moduleevaluation
    #Evaluate(HostDefined: Task) {
        let module: Module = this
        // TODO: Assert: This call to Evaluate is not happening at the same time as another call to Evaluate within the surrounding agent.
        if (![ModuleStatus.linked, ModuleStatus.evaluatingAsync, ModuleStatus.evaluated].includes(module.#Status))
            assertFailed()
        if ([ModuleStatus.evaluatingAsync, ModuleStatus.evaluated].includes(module.#Status)) {
            module = module.#CycleRoot!
            if (!module) assertFailed() // TODO: https://github.com/tc39/ecma262/issues/2823
        }
        if (module.#TopLevelCapability) return module.#TopLevelCapability.Promise
        const stack: Module[] = []
        const capability = PromiseCapability<void>()
        module.#TopLevelCapability = capability
        try {
            Module.#InnerModuleEvaluation(module, stack, 0, HostDefined)
        } catch (err) {
            for (const m of stack) {
                if (!(m.#Status === ModuleStatus.evaluating)) assertFailed()
                m.#Status = ModuleStatus.evaluated
                m.#EvaluationError = err
            }
            if (!(module.#Status === ModuleStatus.evaluated)) assertFailed()
            if (!(module.#EvaluationError === err)) assertFailed()
            capability.Reject(err)
            return capability.Promise
        }
        if (![ModuleStatus.evaluatingAsync, ModuleStatus.evaluated].includes(module.#Status)) assertFailed()
        if (!(module.#EvaluationError === empty)) assertFailed()
        if (module.#AsyncEvaluation === false) {
            if (!(module.#Status === ModuleStatus.evaluated)) assertFailed()
            capability.Resolve()
        }
        if (!(stack.length === 0)) assertFailed()
        return capability.Promise
    }

    // https://tc39.es/ecma262/#sec-InnerModuleLinking
    static #InnerModuleLinking(module: Module, stack: Module[], index: number) {
        if (
            [ModuleStatus.linking, ModuleStatus.linked, ModuleStatus.evaluatingAsync, ModuleStatus.evaluated].includes(
                module.#Status,
            )
        ) {
            return index
        }
        if (!(module.#Status === ModuleStatus.unlinked)) assertFailed()
        module.#Status = ModuleStatus.linking
        module.#DFSIndex = index
        module.#DFSAncestorIndex = index
        index++
        stack.push(module)
        for (const required of module.#RequestedModules) {
            const requiredModule = this.#GetImportedModule(module, required)
            index = this.#InnerModuleLinking(requiredModule, stack, index)
            if (
                ![
                    ModuleStatus.linking,
                    ModuleStatus.linked,
                    ModuleStatus.evaluatingAsync,
                    ModuleStatus.evaluated,
                ].includes(requiredModule.#Status)
            )
                assertFailed()
            if (stack.includes(requiredModule)) {
                if (!(requiredModule.#Status === ModuleStatus.linking)) assertFailed()
            } else {
                if (!(requiredModule.#Status !== ModuleStatus.linking)) assertFailed()
            }
            if (requiredModule.#Status === ModuleStatus.linking) {
                module.#DFSAncestorIndex = Math.min(
                    module.#DFSAncestorIndex,
                    requiredModule.#DFSAncestorIndex as number,
                )
            }
        }
        module.#InitializeEnvironment()
        if (!(stack.filter((x) => x === module).length === 1)) assertFailed()
        if (!(module.#DFSAncestorIndex <= module.#DFSIndex)) assertFailed()
        if (module.#DFSAncestorIndex === module.#DFSIndex) {
            let done = false
            while (!done) {
                const requiredModule = stack.pop()!
                requiredModule.#Status = ModuleStatus.linked
                if (requiredModule === module) done = true
            }
        }
        return index
    }

    // https://tc39.es/ecma262/#sec-InnerModuleEvaluation
    static #InnerModuleEvaluation(module: Module, stack: Module[], index: number, HostDefined: Task) {
        if ([ModuleStatus.evaluatingAsync, ModuleStatus.evaluated].includes(module.#Status)) {
            if (module.#EvaluationError === empty) return index
            throw module.#EvaluationError
        }
        if (module.#Status === ModuleStatus.evaluating) return index
        if (!(module.#Status === ModuleStatus.linked)) assertFailed()
        module.#Status = ModuleStatus.evaluating
        module.#DFSIndex = index
        module.#DFSAncestorIndex = index
        module.#PendingAsyncDependencies = 0
        index++
        stack.push(module)
        for (const required of module.#RequestedModules) {
            let requiredModule = this.#GetImportedModule(module, required)
            index = this.#InnerModuleEvaluation(requiredModule, stack, index, HostDefined)
            if (
                ![ModuleStatus.evaluating, ModuleStatus.evaluatingAsync, ModuleStatus.evaluated].includes(
                    requiredModule.#Status,
                )
            )
                assertFailed()
            if (stack.includes(requiredModule)) {
                if (!(requiredModule.#Status === ModuleStatus.evaluating)) assertFailed()
            } else {
                if (!(requiredModule.#Status !== ModuleStatus.evaluating)) assertFailed()
            }
            if (requiredModule.#Status === ModuleStatus.evaluating) {
                module.#DFSAncestorIndex = Math.min(
                    module.#DFSAncestorIndex,
                    requiredModule.#DFSAncestorIndex as number,
                )
            } else {
                requiredModule = requiredModule.#CycleRoot!
                if (![ModuleStatus.evaluatingAsync, ModuleStatus.evaluated].includes(requiredModule.#Status))
                    assertFailed()
                if (requiredModule.#EvaluationError !== empty) throw requiredModule.#EvaluationError
            }
            if (requiredModule.#AsyncEvaluation === true) {
                module.#PendingAsyncDependencies++
                requiredModule.#AsyncParentModules.push(module)
            }
        }
        if (module.#PendingAsyncDependencies > 0 || module.#HasTLA) {
            if (!(module.#AsyncEvaluation === false)) assertFailed()
            if (!(module.#__AsyncEvaluationPreviouslyTrue === false)) assertFailed()
            module.#AsyncEvaluation = true
            module.#__AsyncEvaluationPreviouslyTrue = true
            // Note: The order in which module records have their [[AsyncEvaluation]] fields transition to true is significant. (See 16.2.1.5.2.4.)
            if (module.#PendingAsyncDependencies === 0) {
                this.#ExecuteAsyncModule(module, HostDefined)
            }
        } else {
            HostDefined.run(() => module.#ExecuteModule())
        }
        if (!(stack.filter((x) => x === module).length === 1)) assertFailed()
        if (!(module.#DFSAncestorIndex <= module.#DFSIndex)) assertFailed()
        if (module.#DFSAncestorIndex === module.#DFSIndex) {
            let done = false
            while (!done) {
                const requiredModule = stack.pop()!
                if (requiredModule.#AsyncEvaluation === false) {
                    requiredModule.#Status = ModuleStatus.evaluated
                } else {
                    requiredModule.#Status = ModuleStatus.evaluatingAsync
                }
                if (requiredModule === module) done = true
                requiredModule.#CycleRoot = module
            }
        }
        return index
    }

    // https://tc39.es/ecma262/#sec-execute-async-module
    static #ExecuteAsyncModule(module: Module, HostDefined: Task) {
        if (![ModuleStatus.evaluating, ModuleStatus.evaluatingAsync].includes(module.#Status)) assertFailed()
        if (!module.#HasTLA) assertFailed()
        const capability = PromiseCapability<void>()
        capability.Promise.then(
            () => {
                this.#AsyncModuleExecutionFulfilled(module, HostDefined)
            },
            (error) => {
                this.#AsyncModuleExecutionRejected(module, error)
            },
        )
        HostDefined.run(() => module.#ExecuteModule(capability))
    }

    // https://tc39.es/ecma262/#sec-gather-available-ancestors
    static #GatherAvailableAncestors(module: Module, execList: Module[]) {
        for (const m of module.#AsyncParentModules) {
            if (!execList.includes(m) && m.#CycleRoot!.#EvaluationError === empty) {
                if (!(m.#Status === ModuleStatus.evaluatingAsync)) assertFailed()
                if (!(m.#EvaluationError === empty)) assertFailed()
                if (!(m.#AsyncEvaluation === true)) assertFailed()
                if (!((m.#PendingAsyncDependencies as number) > 0)) assertFailed()
                ;(m.#PendingAsyncDependencies as number)--
                if (m.#PendingAsyncDependencies === 0) {
                    execList.push(m)
                    if (!m.#HasTLA) this.#GatherAvailableAncestors(m, execList)
                }
            }
        }
    }

    // https://tc39.es/ecma262/#sec-async-module-execution-fulfilled
    static #AsyncModuleExecutionFulfilled(module: Module, HostDefined: Task) {
        if (module.#Status === ModuleStatus.evaluated) {
            if (!(module.#EvaluationError !== empty)) assertFailed()
            return
        }
        if (!(module.#Status === ModuleStatus.evaluatingAsync)) assertFailed()
        if (!(module.#AsyncEvaluation === true)) assertFailed()
        if (!(module.#EvaluationError === empty)) assertFailed()
        module.#AsyncEvaluation = false
        module.#Status = ModuleStatus.evaluated
        if (module.#TopLevelCapability) {
            if (!(module.#CycleRoot === module)) assertFailed()
            module.#TopLevelCapability.Resolve()
        }
        const execList: Module[] = []
        this.#GatherAvailableAncestors(module, execList)
        // TODO: Let sortedExecList be a List whose elements are the elements of execList, in the order in which they had their [[AsyncEvaluation]] fields set to true in InnerModuleEvaluation.
        const sortedExecList = execList
        if (
            !sortedExecList.every(
                (x) => x.#AsyncEvaluation && x.#PendingAsyncDependencies === 0 && x.#EvaluationError === empty,
            )
        )
            assertFailed()
        for (const m of sortedExecList) {
            if (m.#Status === ModuleStatus.evaluated) {
                if (!(m.#EvaluationError !== empty)) assertFailed()
            } else if (m.#HasTLA) {
                this.#ExecuteAsyncModule(m, HostDefined)
            } else {
                try {
                    HostDefined.run(() => m.#ExecuteModule())
                } catch (err) {
                    this.#AsyncModuleExecutionRejected(m, err)
                    continue
                }
                m.#Status = ModuleStatus.evaluated
                if (m.#TopLevelCapability) {
                    if (!(m.#CycleRoot === m)) assertFailed()
                    m.#TopLevelCapability.Resolve()
                }
            }
        }
    }

    // https://tc39.es/ecma262/#sec-async-module-execution-rejected
    static #AsyncModuleExecutionRejected = (module: Module, error: unknown) => {
        if (module.#Status === ModuleStatus.evaluated) {
            if (!(module.#EvaluationError !== empty)) assertFailed()
            return
        }
        if (!(module.#Status === ModuleStatus.evaluatingAsync)) assertFailed()
        if (!(module.#AsyncEvaluation === true)) assertFailed()
        if (!(module.#EvaluationError === empty)) assertFailed()
        module.#EvaluationError = error
        module.#Status = ModuleStatus.evaluated
        for (const m of module.#AsyncParentModules) {
            this.#AsyncModuleExecutionRejected(m, error)
        }
        if (module.#TopLevelCapability) {
            if (!(module.#CycleRoot === module)) assertFailed()
            module.#TopLevelCapability.Reject(error)
        }
    }
    static #GetModuleNamespace(module: Module): ModuleNamespace {
        if (module.#Namespace) return module.#Namespace
        if (!(module.#Status !== ModuleStatus.new && module.#Status !== ModuleStatus.unlinked)) assertFailed()
        const exportedNames = module.#GetExportedNames()

        const namespaceObject: ModuleNamespace = { __proto__: null }
        const propertiesToBeDefined: PropertyDescriptorMap = {
            __proto__: null!,
            [Symbol.toStringTag]: { value: 'Module' },
        }
        const namespaceProxy = new Proxy(namespaceObject, moduleNamespaceExoticMethods)
        // set it earlier in case of circular dependency
        module.#Namespace = namespaceProxy

        for (const name of exportedNames) {
            const resolution = module.#ResolveExport(name)
            if (resolution === ambiguous || resolution === null) continue

            const { bindingName, module: targetModule } = resolution
            if (bindingName === namespace) {
                propertiesToBeDefined[name] = { enumerable: true, value: Module.#GetModuleNamespace(targetModule) }
            } else {
                if (targetModule.#LocalExportedValues.has(bindingName)) {
                    propertiesToBeDefined[name] = {
                        enumerable: true,
                        // Note: this should not be configurable, but it's a trade-off for DX.
                        configurable: true,
                        value: targetModule.#LocalExportedValues.get(bindingName)!,
                    }
                } else {
                    propertiesToBeDefined[name] = {
                        get() {
                            throw new ReferenceError(`Cannot access '${name}' before initialization`)
                        },
                        // Note: this should not be configurable, but it's a trade-off for DX.
                        configurable: true,
                        enumerable: true,
                    }
                }
                targetModule.#non_std_AddLiveExportCallback(name, (newValue) => {
                    Object.defineProperty(namespaceObject, name, {
                        enumerable: true,
                        writable: true,
                        value: newValue,
                    })
                })
            }
        }
        Object.defineProperties(namespaceObject, propertiesToBeDefined)
        return namespaceProxy
    }
    //#endregion

    //#region Module refactor methods https://github.com/tc39/ecma262/pull/2905/

    static #GetImportedModule(module: Module, spec: string) {
        const record = module.#LoadedModules.get(spec)
        if (!record) assertFailed()
        return record
    }
    static #LoadImportedModule(
        referrer: Module,
        specifier: string,
        hostDefined: Task,
        state: GraphLoadingState | PromiseCapability<ModuleNamespace>,
    ) {
        if (referrer.#LoadedModules.has(specifier)) {
            const module = referrer.#LoadedModules.get(specifier)!
            this.#FinishLoadingImportedModule(referrer, specifier, NormalCompletion(module), hostDefined)
            return
        }
        if (referrer.#LoadingModules.has(specifier)) {
            referrer.#LoadingModules.get(specifier)!.add(state)
            return
        }
        referrer.#LoadingModules.set(specifier, new Set([state]))
        // Skipped spec:
        // 4. If referrer is not a Source Text Module Record, referrer.[[ModuleInstance]] is undefined, or referrer.[[ModuleInstance]].[[ImportHook]] is undefined, then
        //     a. Perform HostLoadImportedModule(referrer, specifier, hostDefined).
        //     b. Return unused.
        // Reason: we cannot call HostLoadImportedModule and we always have a importHook.
        try {
            const importHookResult = referrer.#ImportHook
                ? Reflect.apply(referrer.#ImportHook, referrer.#HandlerValue, [specifier])
                : Reflect.apply(referrer.#ParentImportHook, undefined, [specifier])
            // unwrap importHookResult here
            const importHookPromise = Promise.resolve(importHookResult)
            // unwrap PromiseResolve(%Promise%, importHookResult.[[Value]]) here
            const onFulfilled = (result: any) => {
                let completion: Completion<Module>
                try {
                    ;(result as Module).#HandlerValue
                    completion = NormalCompletion(result)
                } catch (error) {
                    completion = ThrowCompletion(new TypeError('importHook must return a Module instance'))
                }
                this.#FinishLoadingImportedModule(referrer, specifier, completion, hostDefined)
            }
            const onRejected = (error: any) => {
                this.#FinishLoadingImportedModule(referrer, specifier, ThrowCompletion(error), hostDefined)
            }
            importHookPromise.then(onFulfilled, onRejected)
        } catch (error) {
            this.#FinishLoadingImportedModule(referrer, specifier, ThrowCompletion(error), hostDefined)
        }
    }

    static #FinishLoadingImportedModule(
        referrer: Module,
        specifier: string,
        result: Completion<Module>,
        hostDefined: Task,
    ) {
        if (result.Type === 'normal') {
            const record = referrer.#LoadedModules.get(specifier)
            if (record) {
                if (!(record === result.Value)) assertFailed()
            } else {
                referrer.#LoadedModules.set(specifier, result.Value)
            }
        }
        const loading = referrer.#LoadingModules.get(specifier)!
        if (!loading) assertFailed()
        referrer.#LoadingModules.delete(specifier)
        for (const state of loading) {
            if ('Visited' in state) this.#ContinueModuleLoading(state, result)
            else this.#ContinueDynamicImport(state, result, hostDefined)
        }
    }

    static #ContinueDynamicImport(
        promiseCapability: PromiseCapability<ModuleNamespace>,
        moduleCompletion: Completion<Module>,
        hostDefined: Task,
    ) {
        if (moduleCompletion.Type === 'throw') {
            promiseCapability.Reject(moduleCompletion.Value)
            return
        }
        const module = moduleCompletion.Value
        const loadPromise = module.#LoadRequestedModules(hostDefined)
        function onRejected(reason: unknown) {
            promiseCapability.Reject(reason)
        }
        function linkAndEvaluate() {
            try {
                module.#Link()
                const evaluatePromise = module.#Evaluate(hostDefined)
                function onFulfilled() {
                    const namespace = Module.#GetModuleNamespace(module)
                    promiseCapability.Resolve(namespace)
                }
                evaluatePromise.then(onFulfilled, onRejected)
            } catch (error) {
                promiseCapability.Reject(error)
            }
        }
        loadPromise.then(linkAndEvaluate, onRejected)
    }
    //#endregion
    /** @internal */
    static {
        imports = async (module, options) => {
            const promiseCapability = PromiseCapability<ModuleNamespace>()

            const hostDefined = createTask(`import(<module block>)`)
            Module.#ContinueDynamicImport(promiseCapability, NormalCompletion(module), hostDefined)
            return promiseCapability.Promise as any
        }
        setParentGlobalThis = (module, global) => (module.#GlobalThis = global)
        setParentImportHook = (module, hook) => (module.#ParentImportHook = hook)
        setParentImportMetaHook = (module, hook) => (module.#ParentImportMetaHook = hook)
    }
}
Reflect.defineProperty(Module.prototype, Symbol.toStringTag, {
    configurable: true,
    value: 'Module',
})

interface GraphLoadingState {
    PromiseCapability: PromiseCapability<void>
    IsLoading: boolean
    PendingModulesCount: number
    Visited: Module[]
    HostDefined: Task
}

const enum ModuleStatus {
    new,
    unlinked,
    linking,
    linked,
    evaluating,
    evaluatingAsync,
    evaluated,
}

function createContextObject() {
    const context: VirtualModuleRecordExecuteContext = {} as any
    Object.defineProperties(context, {
        import: { writable: true, enumerable: true, value: undefined },
        importMeta: { writable: true, enumerable: true, value: undefined },
        globalThis: { writable: true, enumerable: true, value: undefined },
    })
    return context
}

const moduleNamespaceExoticMethods: ProxyHandler<any> = {
    // https://tc39.es/ecma262/#sec-module-namespace-exotic-objects
    setPrototypeOf(target, prototype) {
        return prototype === null
    },
    defineProperty(target, p, attributes) {
        if (typeof p === 'symbol') return Reflect.defineProperty(target, p, attributes)
        const current = Reflect.getOwnPropertyDescriptor(target, p)
        if (!current) return false
        if (attributes.configurable) return false
        if (attributes.enumerable === false) return false
        if (attributes.get || attributes.set) return false
        if (attributes.writable === false) return false
        if ('value' in attributes) return Object.is(current.value, attributes.value)
        return true
    },
    set() {
        return false
    },
    preventExtensions() {
        return true
    },
    isExtensible() {
        return false
    },
}

const moduleEnvExoticMethods: ProxyHandler<any> = {
    getOwnPropertyDescriptor: () => undefined,
    defineProperty: () => false,
    deleteProperty: () => false,
    isExtensible: () => false,
    preventExtensions: () => true,
    getPrototypeOf: () => null,
    setPrototypeOf: (_, v) => v === null,
}
