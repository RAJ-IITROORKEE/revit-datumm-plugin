import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {draftingTools,operation,validCommandResponse} from '../dist/drafting.js';

test('C3 named view, quantity and image reads reject unsafe or unbounded inputs',()=>{
  const sessionId=randomUUID();
  assert.equal(draftingTools.get_model_views.schema.safeParse({sessionId,kind:'plans',limit:100}).success,true);
  assert.equal(draftingTools.get_model_views.schema.safeParse({sessionId,kind:'room-color-schemes',limit:100}).success,true);
  assert.equal(draftingTools.get_model_views.schema.safeParse({sessionId,kind:'levels'}).success,true);
  assert.equal(draftingTools.get_model_views.schema.safeParse({sessionId,kind:'phases'}).success,true);
  assert.equal(draftingTools.get_model_views.schema.safeParse({sessionId,kind:'linked-content'}).success,false);
  const colorOperation={kind:'set_room_color_scheme',key:'room-fill',viewId:'view-id',schemeId:'scheme-id'};
  assert.equal(operation.safeParse(colorOperation).success,true);
  assert.equal(operation.safeParse({...colorOperation,viewId:undefined}).success,false);
  assert.equal(operation.safeParse({...colorOperation,categoryId:'OST_Rooms'}).success,false);
  assert.equal(draftingTools.get_model_quantities.schema.safeParse({sessionId,categories:['walls','rooms'],levelId:'native-level'}).success,true);
  assert.equal(draftingTools.get_model_quantities.schema.safeParse({sessionId,categories:['walls','walls']}).success,false);
  assert.equal(draftingTools.get_model_quantities.schema.safeParse({sessionId,categories:['all']}).success,false);
  assert.equal(draftingTools.get_plan_snapshot.schema.safeParse({sessionId,viewId:'native-view'}).success,true);
  assert.equal(draftingTools.get_plan_image.schema.safeParse({sessionId,viewId:'native-view',pixelSize:1601}).success,false);
});

test('C3 response contracts preserve explicit unknown quantities and image provenance',()=>{
  const documentId=randomUUID();
  const views={documentId,revision:2,kind:'plans',total:1,nextOffset:null,
    plans:[{id:'native-view',name:'L1',viewType:'FloorPlan',levelId:'native-level',scale:100,cropActive:true}],
    links:[],levels:[],phases:[],limitations:['Host plans only']};
  assert.equal(validCommandResponse('get_model_views',views),true);
  assert.equal(validCommandResponse('get_model_views',{...views,plans:[{...views.plans[0],scale:0}]}),false);
  assert.equal(validCommandResponse('get_model_views',{...views,kind:'phases',plans:[],total:1,
    phases:[{id:'native-phase',name:'New Construction',sequence:0}]}),true);
  const assignedView={...views,plans:[{...views.plans[0],isTemplate:false,roomColorSchemeId:'scheme-current',roomColorSchemeName:'Room Finish'}]};
  assert.equal(validCommandResponse('get_model_views',assignedView),true);
  assert.equal(validCommandResponse('get_model_views',{...assignedView,plans:[{...assignedView.plans[0],isTemplate:true}]}),false);
  const roomSchemes={...views,kind:'room-color-schemes',plans:[],roomColorSchemes:[{id:'scheme-id',name:'Room Finish',
    categoryId:'OST_Rooms',categoryName:'Rooms',parameterDefinitionId:'-1006901',parameterName:'Department',isByRange:false,entryCount:8}]};
  assert.equal(validCommandResponse('get_model_views',roomSchemes),true);
  assert.equal(validCommandResponse('get_model_views',{...roomSchemes,roomColorSchemes:undefined}),false);
  assert.equal(validCommandResponse('get_model_views',{...roomSchemes,roomColorSchemes:[{...roomSchemes.roomColorSchemes[0],categoryId:'OST_Doors'}]}),false);
  const quantity={documentId,revision:2,scope:'document',levelId:null,categories:['walls'],inspectedHostElements:2,
    totalGroups:1,nextOffset:null,groups:[{category:'walls',levelId:'native-level',typeId:'native-type',typeName:'Generic 150mm',
      count:2,centerlineLengthKnownCount:1,centerlineLengthMm:3200,nativeAreaKnownCount:0,nativeAreaM2:null,
      nativeVolumeKnownCount:0,nativeVolumeM3:null}],limitations:['Links excluded']};
  assert.equal(validCommandResponse('get_model_quantities',quantity),true);
  assert.equal(validCommandResponse('get_model_quantities',{...quantity,groups:[{...quantity.groups[0],nativeAreaM2:'0'}]}),false);
  const image={documentId,revision:2,viewId:'native-view',viewName:'L1',viewType:'FloorPlan',scale:100,cropActive:true,
    width:1024,height:768,contentType:'image/png',base64:'cG5n',provenance:'Native Revit export; visual evidence'};
  assert.equal(validCommandResponse('get_plan_image',image),true);
  assert.equal(validCommandResponse('get_plan_image',{...image,width:4096}),false);
});
