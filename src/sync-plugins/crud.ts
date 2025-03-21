import {
    ObservableEvent,
    ObservableParam,
    UpdateFnParams,
    WaitForSetFnParams,
    applyChanges,
    getNodeValue,
    internal,
    isArray,
    isNullOrUndefined,
    isPromise,
    setAtPath,
    symbolDelete,
} from '@legendapp/state';
import {
    SyncedGetParams,
    SyncedOptions,
    SyncedSetParams,
    SyncedSubscribeParams,
    deepEqual,
    diffObjects,
    internal as internalSync,
    synced,
} from '@legendapp/state/sync';

const { clone } = internal;
const { waitForSet } = internalSync;

export type CrudAsOption = 'Map' | 'object' | 'value' | 'array';

export type CrudResult<T> = T;

export interface SyncedCrudPropsSingle<TRemote extends object, TLocal> {
    get?: (params: SyncedGetParams<TRemote>) => Promise<CrudResult<TRemote | null>> | CrudResult<TRemote | null>;
    list?: never | undefined;
    initial?: InitialValue<TLocal, 'value'>;
    as?: never | 'value';
}
export interface SyncedCrudPropsMany<TRemote extends object, TLocal, TAsOption extends CrudAsOption> {
    list?: (params: SyncedGetParams<TRemote>) => Promise<CrudResult<TRemote[] | null>> | CrudResult<TRemote[] | null>;
    get?: never | undefined;
    as?: TAsOption;
    initial?: InitialValue<TLocal, TAsOption>;
}
export interface SyncedCrudOnSavedParams<TRemote extends object, TLocal> {
    saved: TLocal;
    input: TRemote;
    currentValue: TLocal;
    isCreate: boolean;
    props: SyncedCrudPropsBase<TRemote, TLocal>;
}

export interface WaitForSetCrudFnParams<T> extends WaitForSetFnParams<T> {
    type: 'create' | 'update' | 'delete';
}

export interface SyncedCrudPropsBase<TRemote extends object, TLocal = TRemote>
    extends Omit<SyncedOptions<TRemote, TLocal>, 'get' | 'set' | 'initial' | 'subscribe' | 'waitForSet'> {
    create?(input: TRemote, params: SyncedSetParams<TRemote>): Promise<CrudResult<TRemote> | null | undefined | void>;
    update?(
        input: Partial<TRemote>,
        params: SyncedSetParams<TRemote>,
    ): Promise<CrudResult<Partial<TRemote> | null | undefined | void>>;
    delete?(input: TRemote, params: SyncedSetParams<TRemote>): Promise<any>;
    onSaved?(params: SyncedCrudOnSavedParams<TRemote, TLocal>): Partial<TLocal> | void;
    fieldId?: string;
    fieldUpdatedAt?: string;
    fieldCreatedAt?: string;
    fieldDeleted?: string;
    fieldDeletedList?: string;
    updatePartial?: boolean;
    changesSince?: 'all' | 'last-sync';
    generateId?: () => string | number;
    subscribe?: (params: SyncedSubscribeParams<TRemote[]>) => (() => void) | void;
    waitForSet?:
        | ((params: WaitForSetCrudFnParams<TLocal>) => any)
        | Promise<any>
        | ObservableParam<any>
        | ObservableEvent;
}

type InitialValue<TLocal, TAsOption extends CrudAsOption> = TAsOption extends 'Map'
    ? Map<string | number, TLocal>
    : TAsOption extends 'object'
      ? Record<string | number, TLocal>
      : TAsOption extends 'value'
        ? TLocal
        : TLocal[];

export type SyncedCrudReturnType<TLocal, TAsOption extends CrudAsOption> = TAsOption extends 'Map'
    ? Map<TLocal extends { id: number } ? number : string, TLocal>
    : TAsOption extends 'object'
      ? Record<TLocal extends { id: number } ? number : string, TLocal>
      : TAsOption extends 'value'
        ? TLocal
        : TLocal[];

let _asOption: CrudAsOption;

function transformOut<T1, T2>(data: T1, transform: undefined | ((value: T1) => T2)) {
    return transform ? transform(clone(data)) : data;
}

function ensureId(obj: any, fieldId: string, generateId: () => string | number) {
    if (!obj[fieldId]) {
        obj[fieldId] = generateId();
    }
    return obj[fieldId];
}

function computeLastSync(data: any[], fieldUpdatedAt: string | undefined, fieldCreatedAt: string | undefined) {
    let newLastSync = 0;
    for (let i = 0; i < data.length; i++) {
        const updated =
            (fieldUpdatedAt ? (data[i] as any)[fieldUpdatedAt as any] : 0) ||
            (fieldCreatedAt ? (data[i] as any)[fieldCreatedAt as any] : 0);
        if (updated) {
            newLastSync = Math.max(newLastSync, +new Date(updated));
        }
    }
    return newLastSync;
}

// The get version
export function syncedCrud<TRemote extends object, TLocal = TRemote>(
    props: SyncedCrudPropsSingle<TRemote, TLocal> & SyncedCrudPropsBase<TRemote, TLocal>,
): SyncedCrudReturnType<TLocal, 'value'>;
// The list version
export function syncedCrud<TRemote extends object, TLocal = TRemote, TAsOption extends CrudAsOption = 'object'>(
    props: SyncedCrudPropsMany<TRemote, TLocal, TAsOption> & SyncedCrudPropsBase<TRemote, TLocal>,
): SyncedCrudReturnType<TLocal, Exclude<TAsOption, 'value'>>;
export function syncedCrud<TRemote extends object, TLocal = TRemote, TAsOption extends CrudAsOption = 'object'>(
    props: (SyncedCrudPropsSingle<TRemote, TLocal> | SyncedCrudPropsMany<TRemote, TLocal, TAsOption>) &
        SyncedCrudPropsBase<TRemote, TLocal>,
): SyncedCrudReturnType<TLocal, TAsOption>;
export function syncedCrud<TRemote extends object, TLocal = TRemote, TAsOption extends CrudAsOption = 'object'>(
    props: (SyncedCrudPropsSingle<TRemote, TLocal> | SyncedCrudPropsMany<TRemote, TLocal, TAsOption>) &
        SyncedCrudPropsBase<TRemote, TLocal>,
): SyncedCrudReturnType<TLocal, TAsOption> {
    const {
        get: getFn,
        list: listFn,
        create: createFn,
        update: updateFn,
        delete: deleteFn,
        transform,
        fieldId: fieldIdProp,
        fieldCreatedAt,
        fieldUpdatedAt,
        fieldDeleted,
        fieldDeletedList,
        updatePartial,
        subscribe: subscribeProp,
        onSaved,
        mode: modeParam,
        changesSince,
        generateId,
        waitForSet: waitForSetParam,
        ...rest
    } = props;

    const fieldId = fieldIdProp || 'id';
    const pendingCreates = new Set<string>();

    let asType = props.as as TAsOption;

    if (!asType) {
        asType = (getFn ? 'value' : _asOption || 'object') as CrudAsOption as TAsOption;
    }

    const asMap = asType === 'Map';
    const asArray = asType === 'array';

    const resultsToOutType = (results: any[]) => {
        if (asType === 'value') {
            return results[0];
        }
        const out = asType === 'array' ? [] : asMap ? new Map() : {};
        for (let i = 0; i < results.length; i++) {
            let result = results[i];
            const value = result;
            if (value) {
                // Replace any children with symbolDelete or fieldDeleted with symbolDelete
                result =
                    (fieldDeleted && result[fieldDeleted as any]) ||
                    (fieldDeletedList && result[fieldDeletedList]) ||
                    result[symbolDelete]
                        ? internal.symbolDelete
                        : result;
                if (asArray) {
                    (out as any[]).push(result);
                } else if (asMap) {
                    (out as Map<string, any>).set(value[fieldId], result);
                } else {
                    (out as Record<string, any>)[value[fieldId]] = result;
                }
            }
        }
        return out;
    };

    const transformRows = (data: TRemote[]) => {
        return Promise.all(
            data.map((value: any) =>
                // Skip transforming any children with symbolDelete or fieldDeleted because they'll get deleted by resultsToOutType
                value[symbolDelete] ||
                (fieldDeleted && value[fieldDeleted]) ||
                (fieldDeletedList && value[fieldDeletedList])
                    ? value
                    : transform!.load!(value, 'get'),
            ),
        );
    };

    const get: undefined | ((params: SyncedGetParams<TRemote>) => TLocal | Promise<TLocal>) =
        getFn || listFn
            ? (getParams: SyncedGetParams<TRemote>) => {
                  const { updateLastSync, lastSync, value } = getParams;
                  if (listFn) {
                      const isLastSyncMode = changesSince === 'last-sync';
                      if (isLastSyncMode && lastSync) {
                          getParams.mode =
                              modeParam || (asType === 'array' ? 'append' : asType === 'value' ? 'set' : 'assign');
                      }

                      const listPromise = listFn(getParams);

                      // Note: We don't want this function to be async so we return these functions
                      // as Promise only if listFn returned a promise
                      const toOut = (transformed: TLocal[]) => {
                          if (asType === 'value') {
                              return transformed.length > 0
                                  ? transformed[0]
                                  : ((((isLastSyncMode && lastSync) || fieldDeleted) && value) ?? null);
                          } else {
                              return resultsToOutType(transformed);
                          }
                      };

                      const processResults = (data: TRemote[] | null) => {
                          data ||= [];
                          if (fieldUpdatedAt) {
                              const newLastSync = computeLastSync(data, fieldUpdatedAt, fieldCreatedAt!);

                              if (newLastSync && newLastSync !== lastSync) {
                                  updateLastSync(newLastSync);
                              }
                          }
                          let transformed = data as unknown as TLocal[] | Promise<TLocal[]>;

                          if (transform?.load) {
                              transformed = transformRows(data);
                          }

                          return isPromise(transformed) ? transformed.then(toOut) : toOut(transformed);
                      };

                      return isPromise(listPromise) ? listPromise.then(processResults) : processResults(listPromise);
                  } else if (getFn) {
                      const dataPromise = getFn(getParams);

                      // Note: We don't want this function to be async so we return these functions
                      // as Promise only if getFn returned a promise
                      const processData = (data: TRemote | null) => {
                          let transformed = data as unknown as TLocal | Promise<TLocal>;
                          if (data) {
                              const newLastSync =
                                  (data as any)[fieldUpdatedAt as any] || (data as any)[fieldCreatedAt as any];
                              if (newLastSync && newLastSync !== lastSync) {
                                  updateLastSync(newLastSync);
                              }
                              if (transform?.load) {
                                  transformed = transform.load(data, 'get');
                              }
                          }

                          return transformed as any;
                      };

                      return isPromise(dataPromise) ? dataPromise.then(processData) : processData(dataPromise);
                  }
              }
            : undefined;

    const set =
        createFn || updateFn || deleteFn
            ? async (params: SyncedSetParams<any> & { retryAsCreate?: boolean }) => {
                  const { value, changes, update, retryAsCreate, node } = params;
                  const creates = new Map<string, TLocal>();
                  const updates = new Map<string, object>();
                  const deletes = new Set<TRemote>();

                  const getUpdateValue = (itemValue: object, prev: object) => {
                      return updatePartial
                          ? Object.assign(
                                diffObjects(prev, itemValue, /*deep*/ true),
                                (itemValue as any)[fieldId] ? { [fieldId]: (itemValue as any)[fieldId] } : {},
                            )
                          : itemValue;
                  };

                  changes.forEach((change) => {
                      const { path, prevAtPath, valueAtPath, pathTypes } = change;
                      if (asType === 'value') {
                          if (value) {
                              let id = value?.[fieldId];
                              let isCreate = fieldCreatedAt ? !value[fieldCreatedAt!] : !prevAtPath;
                              if (!id && generateId) {
                                  id = ensureId(value, fieldId, generateId);
                              }
                              if (id) {
                                  if (pendingCreates.has(id)) {
                                      isCreate = false;
                                  }
                                  if (isCreate || retryAsCreate) {
                                      if (createFn) {
                                          creates.set(id, value);
                                      } else {
                                          console.warn('[legend-state] missing create function');
                                      }
                                  } else if (path.length === 0) {
                                      if (valueAtPath) {
                                          updates.set(id, getUpdateValue(valueAtPath, prevAtPath));
                                      } else if (prevAtPath) {
                                          deletes.add(prevAtPath);
                                      }
                                  } else if (!updates.has(id)) {
                                      const previous = applyChanges(clone(value), changes, /*applyPrevious*/ true);
                                      updates.set(id, getUpdateValue(value, previous));
                                  }
                              } else {
                                  console.error('[legend-state]: added synced item without an id');
                              }
                          } else if (path.length === 0) {
                              deletes.add(prevAtPath);
                          }
                      } else {
                          // key, value, previous
                          let itemsChanged: [any, any][] | undefined = [];
                          if (path.length === 0) {
                              // Do a deep equal of each element vs its previous element to see which have changed
                              const changed = asMap
                                  ? Array.from((valueAtPath as Map<any, any>).entries())
                                  : Object.entries(valueAtPath);

                              for (let i = 0; i < changed.length; i++) {
                                  const [key, value] = changed[i];
                                  const prev = asMap ? prevAtPath.get(key) : prevAtPath[key];
                                  if (isNullOrUndefined(value) && !isNullOrUndefined(prev)) {
                                      deletes.add(prev);
                                      return false;
                                  } else {
                                      const isDiff = !prevAtPath || !deepEqual(value, prev);

                                      if (isDiff) {
                                          itemsChanged.push([getUpdateValue(value, prev), prev]);
                                      }
                                  }
                              }
                          } else {
                              const itemKey = path[0];
                              const itemValue = asMap ? value.get(itemKey) : value[itemKey];
                              if (!itemValue) {
                                  if (path.length === 1 && prevAtPath) {
                                      deletes.add(prevAtPath);
                                  }
                              } else {
                                  const previous = setAtPath(
                                      clone(itemValue),
                                      path.slice(1),
                                      pathTypes.slice(1),
                                      prevAtPath,
                                  );

                                  itemsChanged = [[getUpdateValue(itemValue, previous), previous]];
                              }
                          }
                          itemsChanged?.forEach(([item, prev]) => {
                              const isCreate =
                                  !pendingCreates.has(item[fieldId]) &&
                                  (fieldCreatedAt
                                      ? !item[fieldCreatedAt!] && !prev?.[fieldCreatedAt!]
                                      : fieldUpdatedAt
                                        ? !item[fieldUpdatedAt] && !prev?.[fieldCreatedAt!]
                                        : isNullOrUndefined(prev));
                              if (isCreate) {
                                  if (generateId) {
                                      ensureId(item, fieldId, generateId);
                                  }
                                  if (!item[fieldId]) {
                                      console.error('[legend-state]: added item without an id');
                                  }
                                  if (createFn) {
                                      pendingCreates.add(item[fieldId]);
                                      creates.set(item[fieldId], item);
                                  } else {
                                      console.warn('[legend-state] missing create function');
                                  }
                              } else {
                                  if (updateFn) {
                                      updates.set(
                                          item[fieldId],
                                          updates.has(item[fieldId])
                                              ? Object.assign(updates.get(item[fieldId])!, item)
                                              : item,
                                      );
                                  } else {
                                      console.warn('[legend-state] missing update function');
                                  }
                              }
                          });
                      }
                  });

                  const saveResult = async (
                      itemKey: string,
                      input: TRemote,
                      data: CrudResult<TRemote>,
                      isCreate: boolean,
                  ) => {
                      if (data) {
                          let saved: Partial<TLocal> = (
                              transform?.load ? await transform.load(data as any, 'set') : data
                          ) as any;

                          const isChild = itemKey !== 'undefined' && asType !== 'value';
                          const currentPeeked = getNodeValue(node);

                          // If this is a child then get the value from the parent
                          // If it's an array then find the value in the array
                          // Otherwise get the value from the object
                          const currentValue = isChild
                              ? ((asType === 'array' && isArray(currentPeeked)
                                    ? currentPeeked.find((v) => v[fieldId] === itemKey)
                                    : undefined) ?? currentPeeked[itemKey])
                              : currentPeeked;

                          // If this value has been deleted locally before this finished saving then ignore the result
                          if (saved && !isNullOrUndefined(currentValue)) {
                              if (onSaved) {
                                  // First call onSaved the saved value before removing keys
                                  const ret = onSaved({
                                      saved: saved as TLocal,
                                      input,
                                      currentValue,
                                      isCreate,
                                      props,
                                  });

                                  if (ret) {
                                      saved = ret;
                                  }
                              }

                              // Remove keys from saved that have been modified locally since saving
                              saved = clone(saved) as TLocal;
                              Object.keys(saved).forEach((key) => {
                                  const i = (input as any)[key];
                                  const c = currentValue[key];
                                  if (
                                      // value is already the new value, can ignore
                                      (saved as any)[key] === c ||
                                      // user has changed local value
                                      (key !== fieldId && i !== c)
                                  ) {
                                      delete (saved as any)[key];
                                  }
                              });

                              const createdAt = fieldCreatedAt ? saved[fieldCreatedAt as keyof TLocal] : undefined;
                              const updatedAt = fieldUpdatedAt ? saved[fieldUpdatedAt as keyof TLocal] : undefined;

                              let value: any;
                              if (asType === 'array') {
                                  const index = (currentPeeked as any[]).findIndex(
                                      (cur: any) => cur[fieldId] === itemKey,
                                  );
                                  if (index < 0) {
                                      console.warn('[legend-state] Item saved that does not exist in array', saved);
                                  } else {
                                      value = { [index < 0 ? 0 : index]: saved };
                                  }
                              } else {
                                  value = itemKey !== 'undefined' && asType !== 'value' ? { [itemKey]: saved } : saved;
                              }

                              if (value !== undefined) {
                                  update({
                                      value,
                                      lastSync:
                                          updatedAt || createdAt
                                              ? +new Date(updatedAt || (createdAt as any))
                                              : undefined,
                                      mode: 'merge',
                                  });
                              }
                          }
                      }
                  };

                  return Promise.all([
                      ...Array.from(creates).map(async ([itemKey, itemValue]) => {
                          if (waitForSetParam) {
                              await waitForSet(waitForSetParam as any, changes, itemValue, { type: 'create' });
                          }
                          const createObj = (await transformOut(itemValue as any, transform?.save)) as TRemote;
                          return createFn!(createObj, params)
                              .then((result) => {
                                  return saveResult(itemKey, createObj, result as any, true);
                              })
                              .finally(() => {
                                  pendingCreates.delete(itemKey);
                              });
                      }),
                      ...Array.from(updates).map(async ([itemKey, itemValue]) => {
                          if (waitForSetParam) {
                              await waitForSet(waitForSetParam as any, changes, itemValue, { type: 'update' });
                          }
                          const toSave = itemValue;
                          const changed = (await transformOut(toSave as TLocal, transform?.save)) as TRemote & {};

                          if (Object.keys(changed).length > 0) {
                              return updateFn!(changed, params).then(
                                  (result) => result && saveResult(itemKey, changed, result as any, false),
                              );
                          }
                      }),
                      ...Array.from(deletes).map(async (valuePrevious) => {
                          // Don't delete if already deleted
                          if (valuePrevious !== (symbolDelete as any)) {
                              if (waitForSetParam) {
                                  await waitForSet(waitForSetParam as any, changes, valuePrevious, { type: 'delete' });
                              }
                              if (deleteFn) {
                                  deleteFn(valuePrevious, params);
                              } else if (fieldDeleted && updateFn) {
                                  const valueId = (valuePrevious as any)[fieldId];
                                  if (valueId) {
                                      // Update with fieldDeleted set to true
                                      updateFn({ ...{ [fieldId]: valueId }, [fieldDeleted]: true } as any, params);
                                  } else {
                                      console.error('[legend-state]: deleting item without an id');
                                  }
                              } else {
                                  console.warn('[legend-state] missing delete function');
                              }
                          }
                      }),
                  ]);
              }
            : undefined;

    const subscribe: SyncedOptions['subscribe'] = subscribeProp
        ? (params: SyncedSubscribeParams) =>
              subscribeProp({
                  ...params,
                  update: async (paramsUpdate) => {
                      const paramsForUpdate: UpdateFnParams<any> = paramsUpdate as any;

                      const rows = paramsUpdate.value as any[];

                      if (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') {
                          if (!isArray(rows)) {
                              console.error('[legend-state] subscribe:update expects an array of changed items');
                          }
                      }

                      const newLastSync = computeLastSync(rows, fieldUpdatedAt, fieldCreatedAt);
                      if (newLastSync) {
                          paramsForUpdate.lastSync = newLastSync;
                      }

                      const rowsTransformed = transform?.load ? await transformRows(rows) : rows;

                      paramsForUpdate.value = resultsToOutType(rowsTransformed);
                      params.update(paramsForUpdate);
                  },
              })
        : undefined;

    return synced<any>({
        set,
        get,
        subscribe,
        mode: modeParam,
        ...rest,
    });
}
