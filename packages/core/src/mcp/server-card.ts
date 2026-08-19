import { createHash } from 'node:crypto';
import Ajv2020, { type ErrorObject } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { DiscoveryValidation, ServerCardObservation, ServerCardRemoteObservation, ValidationIssue } from '@interfacedelta/contracts';
import type { RetrievalResult, SafeOutboundClient } from '../scanner/outbound-boundary';
import { parsePublicHttpsEndpoint } from '../scanner/target-policy';
import schemaBundle from '../discovery/schemas/experimental-mcp-server-card.schema.json';

export const SERVER_CARD_SCHEMA = {
  name: 'Experimental MCP Server Card', version: 'v1 pre-release', revision: '526201bbc80231daa40ffcdecfc9da4e54e5dc93',
  file: 'schema.json#/$defs/ServerCard', sha256: '2c772b51edb367f154771d84ddbae87ddba00a624422c8e46f218a9ac03bf042',
} as const;

const ajv = new Ajv2020({ allErrors:true, strict:false }); addFormats(ajv);
const validator = ajv.compile({ $defs:(schemaBundle as {$defs:unknown}).$defs, $ref:'#/$defs/ServerCard' });
const issues=(errors:ErrorObject[]|null|undefined):ValidationIssue[]=>(errors??[]).map(error=>({code:error.keyword,instancePath:error.instancePath,schemaPath:error.schemaPath,message:error.message??'Validation failed.',params:error.params as Record<string,unknown>}));
const validation=(valid:boolean):DiscoveryValidation=>({valid,schemaName:SERVER_CARD_SCHEMA.name,schemaVersion:SERVER_CARD_SCHEMA.version,schemaRevision:SERVER_CARD_SCHEMA.revision,schemaFile:SERVER_CARD_SCHEMA.file,schemaSha256:SERVER_CARD_SCHEMA.sha256,errors:issues(validator.errors)});

type Card={name:string;version:string;description:string;title?:string;remotes?:{type:string;url:string;headers?:unknown[];variables?:Record<string,unknown>}[]};
export function validateServerCard(document:unknown):{validation:DiscoveryValidation;card?:Card}{const valid=validator(document);return valid?{validation:validation(true),card:document as Card}:{validation:validation(false)};}

function network(result:RetrievalResult){return result.ok?{httpStatus:result.httpStatus,bytes:result.body.length,durationMs:result.durationMs,sha256:createHash('sha256').update(result.body).digest('hex'),finalUrl:result.finalUrl,redirects:result.redirects}:{httpStatus:result.httpStatus,durationMs:result.durationMs,finalUrl:result.finalUrl,redirects:result.redirects};}
function remotes(card:Card,serviceOrigin:URL):ServerCardRemoteObservation[]{return(card.remotes??[]).map(remote=>{
  if(remote.type!=='streamable-http')return{transport:remote.type,remoteEndpoint:remote.url,concrete:false,headersDeclared:Boolean(remote.headers?.length),probePolicy:'unsupported_transport',reason:'Only streamable-http remotes are eligible.'};
  const templated=/\{[^}]+\}/.test(remote.url);const headersDeclared=Boolean(remote.headers?.length);
  if(templated)return{transport:remote.type,remoteEndpoint:remote.url,concrete:false,headersDeclared,probePolicy:'configuration_required',reason:'Remote URL contains unresolved template variables.'};
  if(headersDeclared)return{transport:remote.type,remoteEndpoint:remote.url,concrete:true,headersDeclared,probePolicy:'configuration_required',reason:'Server Card declares custom headers; InterfaceDelta does not resolve or send them.'};
  try{const endpoint=parsePublicHttpsEndpoint(remote.url);return{transport:remote.type,remoteEndpoint:endpoint.href,concrete:true,headersDeclared:false,probePolicy:endpoint.origin===serviceOrigin.origin?'eligible':'remote_declared_not_probed',reason:endpoint.origin===serviceOrigin.origin?undefined:'Derived MCP endpoint is cross-origin and was not automatically contacted.'};}
  catch{return{transport:remote.type,remoteEndpoint:remote.url,concrete:false,headersDeclared:false,probePolicy:'configuration_required',reason:'Remote URL does not meet the public HTTPS endpoint policy.'};}
});}

export async function observeServerCard(serviceOrigin:URL,serverCardUrl:string,outbound:SafeOutboundClient):Promise<ServerCardObservation>{
  let url:URL;try{url=parsePublicHttpsEndpoint(serverCardUrl);}catch{return{source:'ard_declared',serverCardUrl,status:'blocked',fetched:false,remotes:[],error:{code:'INVALID_SERVER_CARD_URL',message:'Server Card URL does not meet the public HTTPS policy.'}};}
  if(url.origin!==serviceOrigin.origin)return{source:'ard_declared',serverCardUrl:url.href,status:'declared_not_fetched',fetched:false,remotes:[],error:{code:'CROSS_ORIGIN_CARD_NOT_FETCHED',message:'Cross-origin Server Card declaration was recorded but not fetched.'}};
  const result=await outbound.get(url);if(!result.ok)return{source:'ard_declared',serverCardUrl:url.href,status:result.code==='TARGET_BLOCKED'?'blocked':'unreachable',fetched:false,remotes:[],network:network(result),error:{code:result.code,message:result.message}};
  const base={source:'ard_declared' as const,serverCardUrl:url.href,fetched:true,network:network(result)};
  if(result.httpStatus===404)return{...base,status:'not_found',remotes:[]};
  if(result.httpStatus<200||result.httpStatus>=300)return{...base,status:'unreachable',remotes:[],error:{code:'HTTP_ERROR',message:`Server Card returned HTTP ${result.httpStatus}.`}};
  let document:unknown;try{document=JSON.parse(result.body.toString('utf8'));}catch{return{...base,status:'malformed_json',remotes:[],error:{code:'INVALID_JSON',message:'Server Card response is not valid JSON.'}};}
  const checked=validateServerCard(document);if(!checked.validation.valid)return{...base,status:'invalid',validation:checked.validation,remotes:[],error:{code:'SCHEMA_INVALID',message:'Document does not match the pinned experimental Server Card schema.'}};
  const card=checked.card!;return{...base,status:'valid',validation:checked.validation,identity:{name:card.name,version:card.version,description:card.description,title:card.title},remotes:remotes(card,serviceOrigin)};
}
