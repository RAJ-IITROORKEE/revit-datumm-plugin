import { z } from 'zod';
const id = z.string().min(1).max(200);
const point = z.object({ x: z.number().finite().min(-1000000).max(1000000), y: z.number().finite().min(-1000000).max(1000000) }).strict();
const key = z.string().min(1).max(64);
const elementIds = z.array(id).min(1).max(100).refine(rows=>new Set(rows).size===rows.length);
const regionPoint = z.object({x:z.number().finite().min(-1000000).max(1000000),y:z.number().finite().min(-1000000).max(1000000),z:z.number().finite().min(-1000000).max(1000000)}).strict();
const region = z.object({units:z.literal('mm'),coordinateFrame:z.literal('revit-internal-xyz'),minMm:regionPoint,maxMm:regionPoint}).strict()
  .refine(row=>['x','y','z'].every(axis=>row.minMm[axis as keyof typeof row.minMm]<row.maxMm[axis as keyof typeof row.maxMm]));
const roomMetadataText = z.string().min(1).max(100).regex(/^\S(?:[\s\S]*\S)?$/);
const setRoomMetadata = z.union([
  z.object({ kind: z.literal('set_room_metadata'), key, elementId: id, name: roomMetadataText, number: roomMetadataText.optional() }).strict(),
  z.object({ kind: z.literal('set_room_metadata'), key, elementId: id, number: roomMetadataText, name: roomMetadataText.optional() }).strict(),
]);
const setRoomColorScheme = z.object({ kind: z.literal('set_room_color_scheme'), key, viewId: id, schemeId: id }).strict();
export const operation = z.union([
  z.object({ kind: z.literal('wall'), key, typeId: id, start: point, end: point, heightMm: z.number().gt(100).max(20000) }).strict(),
  z.object({ kind: z.literal('floor'), key, typeId: id, boundary: z.array(point).min(3).max(64) }).strict(),
  z.object({ kind: z.literal('door'), key, typeId: id, host: id, point, sillMm: z.number().min(0).max(10000) }).strict(),
  z.object({ kind: z.literal('window'), key, typeId: id, host: id, point, sillMm: z.number().min(0).max(10000) }).strict(),
  z.object({ kind: z.literal('room'), key, point, name: z.string().min(1).max(100) }).strict(),
  z.object({ kind: z.literal('room_tag'), key, elementId: id, viewId: id, typeId: id, point }).strict(),
  z.object({ kind: z.literal('family_instance'), key, typeId: id, point, rotationDegrees: z.number().finite().min(0).lt(360) }).strict(),
  z.object({ kind: z.literal('dimension'), key, typeId: id, viewId: id, start: point, end: point,
    stableReferences: z.array(z.string().min(1).max(500)).min(2).max(8).refine(rows=>new Set(rows).size===rows.length) }).strict(),
  z.object({ kind: z.literal('move'), key, elementId: id, point }).strict(),
  z.object({ kind: z.literal('set_comments'), key, elementId: id, value: z.string().max(500) }).strict(),
  setRoomMetadata,
  setRoomColorScheme,
  z.object({ kind: z.literal('change_type'), key, elementId: id, typeId: id }).strict(),
  z.object({ kind: z.literal('delete'), key, elementId: id }).strict(),
]);
export const changeSet = z.object({ documentId: z.string().uuid(), expectedRevision: z.number().int().nonnegative(),
  levelId: id, units: z.literal('mm'), coordinateFrame: z.literal('revit-internal-xy'), title: z.string().min(1).max(120),
  operations: z.array(operation).min(1).max(100) }).strict();
export const draftingTools = {
  get_native_capabilities: {description:'Read native operation schema, supported placements, build and bounded limits. Required before new operation dispatch. Optional mirrorProbe checks only the exact inspected root set for native eligibility; it does not mirror, qualify a plane, verify dimensions or perform rollback.',
    schema:z.object({sessionId:z.string().uuid(),mirrorProbe:z.object({documentId:z.string().uuid(),expectedRevision:z.number().int().nonnegative(),
      levelId:id,viewId:id,elementIds}).strict().optional()}).strict()},
  get_dimension_references: {description:'Discover stable host straight-wall planar side-face references in one inspected floor-plan view. Revision-bound; never guess references.',
    schema:z.object({sessionId:z.string().uuid(),viewId:id,elementIds:z.array(id).min(1).max(20).refine(rows=>new Set(rows).size===rows.length)}).strict()},
  get_model_elements: {description:'Read paginated host-document instances in requested categories, optional native level and up to eight named parameters. Bounded location/boundary evidence; linked models and other categories remain outside coverage.',
    schema:z.object({sessionId:z.string().uuid(),categories:z.array(z.enum(['walls','floors','doors','windows','rooms','room-tags','ceilings','roofs','stairs','furniture','columns','structural-columns','generic-models'])).min(1).max(13),
      levelId:id.optional(),viewId:id.optional(),phaseId:id.optional(),elementIds:elementIds.optional(),region:region.optional(),offset:z.number().int().nonnegative().optional(),limit:z.number().int().min(1).max(100).optional(),parameterNames:z.array(z.string().min(1).max(80)).max(8).optional()}).strict()},
  show_model_elements: {description:'Select/highlight or show inspected host instances in Revit. Exact document/revision required. Changes only view/selection; does not move elements, transact, save or sync.',
    schema:z.object({sessionId:z.string().uuid(),documentId:z.string().uuid(),expectedRevision:z.number().int().nonnegative(),elementIds,viewId:id.optional(),action:z.enum(['select','show'])}).strict()},
  get_model_inventory: { description: 'Read native wall/floor/door/window/room counts and paginated room areas, optionally scoped to an explicit level UniqueId. No model changes.',
    schema: z.object({ sessionId: z.string().uuid(), levelId: id.optional(), offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(100).optional() }).strict() },
  get_model_views: { description: 'Page host floor-plan views, existing room color fill schemes, levels, phases or Revit link instances. Link transforms and loaded state are reported, but linked contents are not inspected. No model changes.',
    schema: z.object({ sessionId: z.string().uuid(), kind: z.enum(['plans','room-color-schemes','links','levels','phases']), offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(100).optional() }).strict() },
  get_model_quantities: { description: 'Aggregate selected host category/level instances by native type. Return known-value counts and wall-centerline, native area and volume sums with explicit units and exclusions. At most 5000 host instances; no linked or material-layer quantities.',
    schema: z.object({sessionId:z.string().uuid(),categories:z.array(z.enum(['walls','floors','doors','windows','rooms'])).min(1).max(5).refine(items=>new Set(items).size===items.length),
      levelId:id.optional(),offset:z.number().int().nonnegative().optional(),limit:z.number().int().min(1).max(100).optional()}).strict()},
  get_plan_snapshot: { description: 'Read measured wall-path geometry, opening markers and room labels from the active or explicitly named host floor-plan view as SVG. At most 2000 visible elements. Not a rendered screenshot. No model changes or active-view switch.',
    schema: z.object({ sessionId: z.string().uuid(), viewId: id.optional() }).strict() },
  get_plan_image: { description: 'Export one selected host floor-plan view as native PNG visual evidence, bounded to 2048 pixels per dimension and 1.5 MB. Not exact geometry. Does not save the model or switch the active view.',
    schema:z.object({sessionId:z.string().uuid(),viewId:id,pixelSize:z.number().int().min(256).max(1600).optional()}).strict()},
  get_model_catalog: { description: 'Read document revision, levels and paginated loaded types. Coordinates use millimetres at Revit internal XY origin.',
    schema: z.object({ sessionId: z.string().uuid(), offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(100).optional() }).strict() },
  get_selection: { description: 'Read up to 100 selected model elements with native UniqueIds.', schema: z.object({ sessionId: z.string().uuid() }).strict() },
  preview_changes: { description: 'Validate exact change set and return proposal/hash. Delete evaluates and rolls back the complete native dependent closure; the hash binds that closure. Requires authenticated chat approval, scoped Full Control or local Revit approval before committing. No transaction is held open.',
    schema: changeSet.extend({ sessionId: z.string().uuid() }).strict() },
  approve_change_set: { description: 'Authorize one exact preview, hash, document and revision from the authenticated dashboard. Does not write the model; apply_change_set remains a separate transaction.',
    schema: z.object({ sessionId: z.string().uuid(), proposalId: z.string().uuid(), approvalHash: z.string().regex(/^[a-f0-9]{64}$/), documentId: z.string().uuid(), expectedRevision: z.number().int().nonnegative() }).strict() },
  apply_change_set: { description: 'Apply approved proposal atomically, or roll back a dry run. Use a fresh UUID operationId, then query it after timeouts. Reusing an ID never executes twice. Dry runs consume the proposal; preview again afterwards.',
    schema: z.object({ sessionId: z.string().uuid(), proposalId: z.string().uuid(), approvalHash: z.string().regex(/^[a-f0-9]{64}$/), operationId: z.string().uuid(), dryRun: z.boolean().optional() }).strict() },
  get_operation_status: { description: 'Read durable operation receipt and current element readback. Unknown outcomes require inspection, never automatic replay.',
    schema: z.object({ sessionId: z.string().uuid(), operationId: z.string().uuid() }).strict() },
};

const receipt = z.object({ operationId: z.string().uuid(), proposalHash: z.string().regex(/^[a-f0-9]{64}$/),
  documentId: z.string().uuid(), state: z.enum(['running', 'committed', 'rolled_back', 'failed']), elementIds: z.array(z.string()),
  warnings: z.array(z.string()), error: z.string().nullable(), updatedAt: z.string(),
  operationElements: z.record(z.string(),z.string()).nullable().optional(),
  version:z.number().int().min(2).nullable().optional(),createdElementIds:z.array(z.string()).nullable().optional(),
  modifiedElementIds:z.array(z.string()).nullable().optional(),deletedElementIds:z.array(z.string()).nullable().optional() }).strict();
const deletion = z.object({ key, targetId:id, elements:z.array(z.object({nativeId:z.number().int(),id,kind:z.enum(['wall','floor','door','window','room','room_tag','dimension','family_instance','nested_component']),name:z.string()}).strict()).min(1).max(64) }).strict();
const vector=z.object({x:z.number().finite(),y:z.number().finite(),z:z.number().finite()}).strict();
const evidence=z.object({coverage:z.string(),viewId:z.string().nullable(),cropActive:z.boolean().nullable(),
  crop:z.object({minMm:vector,maxMm:vector,originMm:vector,basisX:vector,basisY:vector,basisZ:vector}).strict().nullable(),
  coordinateFrame:z.literal('revit-internal-xy'),units:z.literal('mm'),pixelToModel:z.string(),lengthDisplayUnit:z.string()}).strict();
export function validCommandResponse(tool: string, data: unknown): boolean {
  const identity = { documentId: z.string().uuid(), revision: z.number().int().nonnegative() };
  const status = z.object({ receipt: receipt.nullable(), state: z.enum(['unknown', 'committed', 'rolled_back', 'failed', 'not_found']),
    sameDocument: z.boolean(), elements: z.array(z.unknown()).nullable(),
    deletedElements:z.array(z.object({id,missing:z.boolean()}).strict()).nullable().optional(), guidance: z.string() }).strict();
  const schemas: Record<string, z.ZodType> = {
    get_native_capabilities:z.object({...identity,schemaVersion:z.literal(1),operationSchemaVersion:z.union([z.literal(2),z.literal(3)]),inspectionSchemaVersion:z.literal(2).optional(),minimumMcpVersion:z.enum(['0.2.0-alpha.2','0.2.0-alpha.3','0.2.0-alpha.4','0.2.0-alpha.5']),
      pluginVersion:z.string(),revitBuild:z.string(),operationKinds:z.array(z.string()).max(20),placementSupport:z.array(z.string()).max(10),
      roomTagPolicy:z.literal('explicit-reviewed-operations').optional(),limits:z.object({operations:z.literal(100),pageSize:z.literal(100),dimensionReferences:z.literal(8),imageBytes:z.literal(1500000),imagePixels:z.literal(2048)}).strict(),limitations:z.array(z.string()),
      mirrorProbe:z.object({...identity,levelId:id,viewId:id,elementIds,eligibilityOnly:z.literal(true),qualified:z.literal(false),modelChanged:z.literal(false),
        canMirrorElements:z.boolean(),reasons:z.array(z.string()).max(10),limitations:z.array(z.string()).min(1).max(10)}).strict().optional()}).strict(),
    get_dimension_references:z.object({...identity,viewId:id,evidence,references:z.array(z.object({elementId:id,stableReference:z.string().min(1).max(500),originMm:vector,normal:vector}).strict()).max(80),limitations:z.array(z.string())}).strict(),
    get_model_elements:z.object({...identity,units:z.literal('mm'),coordinateFrame:z.literal('revit-internal-xy'),categories:z.array(z.string()),levelId:z.string().nullable(),
      evidence:evidence.optional(),phaseId:id.nullable().optional(),elementIds:elementIds.nullable().optional(),region:region.nullable().optional(),total:z.number().int().nonnegative(),nextOffset:z.number().int().nonnegative().nullable(),elements:z.array(z.object({element:z.unknown(),parameters:z.array(z.object({name:z.string(),storageType:z.string(),value:z.string().nullable()}).strict()).max(32)}).strict()).max(100),limitations:z.array(z.string())}).strict(),
    show_model_elements:z.object({...identity,action:z.enum(['select','show']),elementIds,viewId:id,modelChanged:z.literal(false)}).strict(),
    get_model_inventory: z.object({ ...identity, title: z.string(), scope: z.enum(['document','level']), levelId: z.string().nullable(),
      counts: z.object({ walls: z.number().int().nonnegative(), floors: z.number().int().nonnegative(), doors: z.number().int().nonnegative(), windows: z.number().int().nonnegative(), rooms: z.number().int().nonnegative() }).strict(),
      evidence:evidence.optional(),rooms: z.array(z.object({ id: z.string(), name: z.string(), number: z.string(), areaM2: z.number().nonnegative(), levelId: z.string().nullable(), enclosed: z.boolean() }).strict()).max(100), totalRooms: z.number().int().nonnegative(), nextOffset: z.number().int().nullable() }).strict(),
    get_model_views: z.object({ ...identity, kind:z.enum(['plans','room-color-schemes','links','levels','phases']),total:z.number().int().nonnegative(),nextOffset:z.number().int().nonnegative().nullable(),
      evidence:evidence.optional(),plans:z.array(z.object({id,name:z.string(),viewType:z.literal('FloorPlan'),isTemplate:z.literal(false).optional(),levelId:z.string().nullable(),
        roomColorSchemeId:z.string().nullable().optional(),roomColorSchemeName:z.string().nullable().optional(),
        scale:z.number().int().positive(),cropActive:z.boolean(),evidence:evidence.optional()}).strict()).max(100),
      roomColorSchemes:z.array(z.object({id,name:z.string(),categoryId:z.literal('OST_Rooms'),categoryName:z.string(),parameterDefinitionId:z.string(),
        parameterName:z.string().nullable(),isByRange:z.boolean(),entryCount:z.number().int().nonnegative()}).strict()).max(100).optional(),
      links:z.array(z.object({id:z.string(),name:z.string(),loaded:z.boolean(),linkedDocumentId:id.nullable().optional(),originMm:z.object({x:z.number(),y:z.number(),z:z.number()}).strict(),
        basisX:z.object({x:z.number(),y:z.number(),z:z.number()}).strict(),basisY:z.object({x:z.number(),y:z.number(),z:z.number()}).strict(),basisZ:vector.optional()}).strict()).max(100),
      levels:z.array(z.object({id:z.string(),name:z.string(),elevationMm:z.number()}).strict()).max(100),
      phases:z.array(z.object({id:z.string(),name:z.string(),sequence:z.number().int().nonnegative()}).strict()).max(100),
      limitations:z.array(z.string())}).strict().superRefine((row,ctx)=>{
        if(row.kind==='room-color-schemes' && !row.roomColorSchemes)
          ctx.addIssue({code:z.ZodIssueCode.custom,message:'Room color scheme reads must include the native roomColorSchemes catalog.'});
      }),
    get_model_quantities:z.object({...identity,scope:z.enum(['document','level']),levelId:z.string().nullable(),categories:z.array(z.string()),
      evidence:evidence.optional(),inspectedHostElements:z.number().int().nonnegative(),totalGroups:z.number().int().nonnegative(),nextOffset:z.number().int().nonnegative().nullable(),
      groups:z.array(z.object({category:z.string(),levelId:z.string().nullable(),typeId:z.string().nullable(),typeName:z.string().nullable(),
        count:z.number().int().nonnegative(),centerlineLengthKnownCount:z.number().int().nonnegative(),centerlineLengthMm:z.number().nullable(),
        nativeAreaKnownCount:z.number().int().nonnegative(),nativeAreaM2:z.number().nullable(),nativeVolumeKnownCount:z.number().int().nonnegative(),
        nativeVolumeM3:z.number().nullable()}).strict()).max(100),limitations:z.array(z.string())}).strict(),
    get_plan_snapshot: z.object({ ...identity, title: z.string(), viewId: z.string(), viewName: z.string(), units: z.literal('mm'), coordinateFrame: z.literal('revit-internal-xy'),
      evidence:evidence.optional(),svg: z.string().max(2000000), elementCount: z.number().int().max(2000), skippedWalls: z.number().int().nonnegative(), provenance: z.string() }).strict(),
    get_plan_image:z.object({...identity,viewId:z.string(),viewName:z.string(),viewType:z.literal('FloorPlan'),scale:z.number().int().positive(),
      cropActive:z.boolean(),width:z.number().int().min(1).max(2048),height:z.number().int().min(1).max(2048),
      evidence:evidence.optional(),contentType:z.literal('image/png'),base64:z.string().max(2000000),provenance:z.string()}).strict(),
    get_model_catalog: z.object({ ...identity, title: z.string(), units: z.literal('mm'), coordinateFrame: z.literal('revit-internal-xy'),
      evidence:evidence.optional(),supportedForWrites: z.boolean(), levels: z.array(z.object({ id: z.string(), name: z.string(), elevationMm: z.number() }).strict()),
      types: z.array(z.object({ id: z.string(), name: z.string(), kind: z.enum(['wall', 'floor', 'door', 'window', 'room_tag','dimension','family_instance']), family: z.string().nullable(), placement: z.string().nullable(),sizes:z.object({widthMm:z.number().nullable(),heightMm:z.number().nullable(),thicknessMm:z.number().nullable()}).strict().optional() }).strict()),
      totalTypes: z.number().int(), nextOffset: z.number().int().nullable() }).strict(),
    get_selection: z.object({ ...identity,evidence:evidence.optional(), elements: z.array(z.unknown()).max(100), total: z.number().int().nonnegative() }).strict(),
    preview_changes: z.object({ ...identity, proposalId: z.string().uuid(), approvalHash: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.string(),
      changes: z.object({}).passthrough(), deletions:z.array(deletion).optional(), approval: z.string() }).strict(),
    approve_change_set: z.object({ approved: z.literal(true), proposalId: z.string().uuid(), approvalHash: z.string().regex(/^[a-f0-9]{64}$/), documentId: z.string().uuid(), revision: z.number().int().nonnegative() }).strict(),
    apply_change_set: z.union([status, z.object({ receipt, revision: z.number().int(), previewOnly: z.boolean().optional(), elements: z.array(z.unknown()).optional(), deletions:z.array(deletion).optional() }).strict()]),
    get_operation_status: status,
  };
  return schemas[tool]?.safeParse(data).success ?? false;
}
