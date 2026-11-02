import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import Ajv2020 from 'ajv/dist/2020.js';
const base=JSON.parse(fs.readFileSync('contracts/dinodia-v1/contract.json'));
const schema=JSON.parse(fs.readFileSync('contracts/dinodia-v1/schemas/automations-v2.schema.json'));
const fixture=JSON.parse(fs.readFileSync('contracts/dinodia-v1/fixtures/automation-device-trigger-v2.json'));
const ajv=new Ajv2020({strict:false});ajv.addSchema(base);ajv.addSchema(schema);
const v2=ajv.getSchema(schema.$id+'#/$defs/definition'),v1=ajv.getSchema(base.$id+'#/$defs/tenantAutomationCreateDefinition');
test('negotiated V2 accepts custom definitions and the unchanged V1 schedule contract rejects them',()=>{
 assert.equal(v2(fixture.definition),true,JSON.stringify(v2.errors));assert.equal(v1(fixture.definition),false);
 const bad=structuredClone(fixture.definition);bad.trigger.authority='OWNER';assert.equal(v2(bad),false);
 const old=JSON.parse(fs.readFileSync('contracts/dinodia-v1/fixtures/automation-stage11-live.json')).definition;
 assert.equal(v1(old),true);assert.equal(v2(old),true);
});
test('V2 fixture/schema copies are identical in the actual Hub and iOS consumers',()=>{
 for(const root of [process.env.DINODIA_OS_ROOT+'/test/fixtures/contracts/dinodia-v1',process.env.DINODIA_IOS_ROOT+'/DinodiaTests/Fixtures/DinodiaV1',process.env.DINODIA_IOS_ROOT+'/Dinodia/DebugFixtures/DinodiaV1'])
  for(const relative of ['schemas/automations-v2.schema.json','fixtures/automation-device-trigger-v2.json'])assert.deepEqual(fs.readFileSync(root+'/'+relative),fs.readFileSync('contracts/dinodia-v1/'+relative));
});
