import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),Ajv=require('ajv/dist/2020.js');
const schema=JSON.parse(fs.readFileSync(new URL('../contracts/dinodia-v1/contract.json',import.meta.url),'utf8'));
const ajv=new Ajv({strict:false});ajv.addSchema(schema);const valid=ajv.compile({$ref:schema.$id+'#/$defs/analyticsBootstrap'});
const legacy={schemaVersion:'dinodia.v1',ok:true,homeId:'synthetic-home',timezone:'Europe/London',generatedAt:'2026-10-27T00:00:00.000Z',
 retentionStartAt:'2025-10-27T00:00:00.000Z',earliestAvailableAt:null,areas:[],displayGroups:[],devices:[],historicalDevices:[],summaries:[],
 temperature:{latestCelsius:null,quality:'unknown',sourceAt:null,validUntil:null},historyState:'empty'};
test('negotiated bootstrap extension is bounded, explicit and preserves the old response shape',()=>{
 assert.equal(valid(legacy),true,JSON.stringify(valid.errors));
 assert.equal(Object.hasOwn(legacy,'stateCategories'),false);
 assert.equal(valid({...legacy,stateCategories:['socket','tv','blind','ac','washing_machine']}),true,JSON.stringify(valid.errors));
 for(const stateCategories of [['tv','tv'],['radiator'],['power'],true,['socket','tv','blind','ac','washing_machine','other']])
  assert.equal(valid({...legacy,stateCategories}),false);
 assert.equal(valid({...legacy,stateCategories:[],unrecognized:true}),false);
});
