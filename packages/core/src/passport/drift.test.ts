import { describe, expect, it } from 'vitest';
import { projectJsonSchema } from '@interfacedelta/schema-compatibility';
import type { AgentPassport } from '@interfacedelta/contracts';
import { normalizeDiscoveryReport } from './normalize';
import { canonicalSha256 } from './canonical-json';
import { comparePassports as currentCompare } from './drift';
import { createHash } from 'node:crypto';
import { extractWebMcpDeclarativeTools } from '../discovery/webmcp-html';
import type { DiscoveryReport } from '@interfacedelta/contracts';

// SHA-256 of the exact JSON output of b90402d for every existing drift fixture.
// Keyed by inputs; pinning raw output bytes also protects change-set fingerprints.
const v8Golden: Record<string, string> = {
  d15e591a9df880342fafbdd14b02440c8d73cf0650c047610ed38a5374f4a470:
    '227fa721b877246fc578447301b0b681eef37f897b9d4d15d40f0148ec8d2701',
  '92ef86e76d718f6548f3d1ac3aa855bd31148313e0ba3e1d6d62ab33d32ec7d3':
    'eaebe923fdd015029c57c7b184d274c798adfbe867df5c03044edaf166da8412',
  '1a4627a0012925c728efc006203205255be5e75677c2f07fe236cb674bdb88ef':
    '7f82c920f340a0785632bc2d6f2e006f18d79074def7270612cdce4a2e17c26f',
  e07b4c91737037c32c6e2dcb84b09da485b9a803ea2a0b49be2b2e5baff43018:
    'a364279051a2910d1722b4f7089e0fb913afbdbca73b4b932afcdbc2c3ca0bc7',
  cb65b89c0b75202e5bef05f0168f5fa2f016d73896672378e7d531e8d1a792c2:
    'd9a8d2bb748a77be725969f1fc3e86da195c48d29ecda062d20fbd6cb56c8ddd',
  '872b4896960ad1115aa5a1b84d1bc1dc683d2b627f6f5d640ec415dabbf74f57':
    '7166a24bb83e7469bd91a25fb0ad3e48aee769a992df73953227604a44c66c10',
  '892c80bc0100990cd7a56853c4211659887d8d32fc12e22908d2dd44fc54bb3b':
    'd271747024f76af4b03bdb4aecf993cf971ea934a95cc1f390f9e4f1e618abc9',
  '6d74ebd2d082bf5a52ac42f0700a8b23c893d3b992e9450da8c49cdd31687818':
    '1fcf5cbb25782c3b0b6ccff4ab72b4a9715351e5a7f50db474c63dd07b69cc0e',
  cec850cd8cb7e6e5d14aa774f27d988130ca9af65c413e5471f7bf0313d99b1a:
    'b8988fb3e78310f4c571d334caa8c092b9382ce90eb06a683d064e003bedc9ea',
  '3afbf9a60e5fd69a3ad19d51e71ac8f9f64527e2c4450f5f322fc972e02b68cb':
    '7a4d6031b87ba4d892a4c65692aedfe465e562fba6b5c9d347efdd267f5af959',
  '973911cc7fd0879b5f195ef94e9ccb6018d88c03b5155806f57a1488473e0d34':
    'dd7b79dfaec28e66979a3508315a3b38a5e13ea84f51d7921408c442df1c21cf',
  e588a7a47499a90fcce93b473352da52fce50647f64b3a6069adb2a5ded0d4b9:
    '1d82a5db0a55a490a24c298de29b1f7704cef4c29de2173c64ac77ba90556c9c',
  '51bb68d4e8bdff4fc87ff566d08f01404e53d3345ca004ecffba09edb320a259':
    '7f4051219e5043abd64a3b5228f93861da2f0117640121914b1605fde49c3f28',
  '4d36a3d76e92a11f1739e049063d006e5a764aa8aad447cfb90e2992ad590325':
    'ba93ef0ed00edf16946bf39525ab46280474394ecc0c2764f54893f20cf0e1a5',
  f225af10a2b34aa1502524e7e93363b8c3ac912a49b0e80039e3f2f7a17f5aa1:
    '7ca7f67214ec3025d5cf1443d58bdc4f8dbc84f146fca35ad2c98f6c9b2a3e3b',
  '1e6d3ee53cacac0e0d734f455fe6e13350380c1cd80f2fad73c79f4a5fbbf5aa':
    '906757e3c9199640d8500a85bf1b0d7b7cab741fc832b53f2e6c350ab5c681ae',
  '874c707172a863a077c9a27c755ceb0ce92264a8ca67663012234cc2828ae412':
    '1288e691e4f0780547fe614ce9bae10170fff1e3cabe4d1a66dfd1044bc89f70',
  '6b2b77a38c82274f98af3b3a6159543cfe23f91bc8e066b46c08ad819a4b3908':
    '86648c61ef432e80b1033bceb0fb7ceb4325c9f804b83b95d37d0199c0c80e48',
  '1965e05804905f71a6a7d65bd3b3c7ee1f3a41e4e5f3493c0c4ede999934d60f':
    'bd75220434453e4ba9240cae7da28bc3d6abd237f7c415a5fefc9b6a097d5a5f',
  b7159da51ecb4fcd59b030feb421d4d093427af64719df7ebc021c7a8bd4c42d:
    'd323f4141b60b041015927bac0d980b76106ea39f19d2dffe508d59532535fc7',
  '92ad3f568bca5dc00407305f40a769258c95122c6bbe39ee9557a8d67f93c71d':
    '309e8dbc672ff8b447a4027ab52ef10e9673604392a67c04e66c80e38e83f34c',
  '1fbde98f3a013bf316de91949b3fc85aae35c7bdd16465e57c7b9c1084edb93d':
    '7238d0adce09b87e7bca9f6e0d5a0423af5c405e71b077b8d3b7f983b9efcdb2',
  fed2aca48466924db1f135951d4e8259b3603a1270f14a2d367d2cdcdb031544:
    'dd7eeed5920d6a511b4b486f204ff83edf99f3622189d2af381ccc6ce73db1d9',
  '60bea68950cd5cfa2d0c254297af167122fd610b7b6a4495f3640bd49812fdd5':
    'a9ef244465d950a7571361d62401d328cea2ed4944bdc7cb6de0787bafa0448c',
  '0699e7368ec85562c9e79461cac060f33d027729b56f5a6c7e8b1a825d86c189':
    'a57c84233151c45a084f9140b2c1aadc0401dbb6ea66219e1c6223ef0805246d',
  '8ba5efaa91d448041e7a2cec27685923ea2bb34353f824a84d932fa010ec6ad6':
    '46a9db0df50e97c0c871a32807620a4e999b16001b6da03c5d777d17e75aef8b',
  '66370b1345c4b1802a07706fdd146eb72a84c3b54411f6f039ec585d0cc95b3a':
    '46a9db0df50e97c0c871a32807620a4e999b16001b6da03c5d777d17e75aef8b',
  c7c19755c6c2aa364efeaf07ba5cb5cc5eca2e4bb4f9279a82197c26dd7b4e57:
    '263ebd776440296392048afe561e5864890c1fcf54b408af4b6ba8834005a765',
  '9e6e5576fee17cf807149b748df39c90566ff3f427f237b2f1ef4c7ab27a987e':
    '6b3dde943116b4639060e53d18a21210985fe1cf84cb5e51f9b763d45ffaecac',
  '12ca9832ed5566ae030570b0880c6951171064398acf2eb9d687572ae0dd36be':
    '67347dc9f51b3c7477da507f05043b3b77867d87e3c5a5010367e63bad7d6ed7',
  '5ce43aa2afa4c6af61ee816757cffa21e89dc7d32a98717a1692dcd16983f6a7':
    '6b2a9b983c4d9349dcc99a09fda72dfdc279c25dec762c3254b22e8f948b7230',
  '54c717be44ec412e46a0a15e68344c150aa00c564b8bfa530b6498e2902b85c6':
    'a95182a7ec64a715cb24fdc859676be84c03a5923cb2b498f0622b80fbde5563',
  '121d1decb524531a5f4e96fb37886a848ecd929bd5be131f8f6ac2c570951bcc':
    'eadd54abfb6819abd5c7e8fb6a26e4de04d611761b570c89abc3fe06fca25726',
  '68dd0af8edda694858a768cd1fc6e6badc62ad2acb2c1b4657bb452e081457d1':
    '48613d760db7a55f37fbfe49ff58d24fba1d1f776a63b133e78517d299d0d2e3',
  '7b48dcf7d1256c562cfeb0c8468f902b2caa110e1c0ea80298f7d1edc791cf2b':
    '89cae1de15279e71d0fd18063e9aeda9d36368fb93f67ec4b50b379ecd17c598',
  '05ed01faa6124b38f3436fa19bbf2ffb60f17ec1fbfec3a0d570944e548c339a':
    'a22591a8a46168f967c9eff1cf8b4a1761edc3a22e6031b07d5c709dd2ff058f',
  '401f682a7530f8209ccd96ddb2c25390902be237b37b9fd92799fa99a5325b62':
    'cf26588a352c5d4afcdd5dd4dc2e4c760037aebc5dede871b6ca019c033ce5a6',
  c8b1bec64f506ee6f2909b00670e66a2a551257b49e80203882e97ddb908522b:
    '4679357f2102c3e6719622c77d2b09d75011c072fed6fc652ac4bcde3a2265f7',
  '2b981c7686764bf1fa94c72ea144b5d56760e63de2f96697d7e7402697a6d55e':
    '96066e6d7783f4ba497bcc2bc9d1a6b7b8c0e71a944bf38c2a4b9b82715d6311',
  e076a3a0a04248f4acccb60ff41bd120b8db3742a5db94a78e3598b4eb748f11:
    'f7bfd32164e14592bd73732369c7541d16ff4995cc6802aa5d233fffce92b5c5',
  eabc1018ddfdc468588e7566180ab1848a66a360695557db28f5976a4ede8aed:
    '98759d28b26428b7ead61da207bd79bbc7b192bf858d6693a8489828c695cf84',
  '67612d4de09147bb5bd9d22bea8c3fc26af9d0605ea9882f44f7fecacf7bcc1b':
    '3c21b22766197816d919734ec0fdea5c06da7088ab23b26ede378102aeef1b75',
  '8220be514a647280f86dc6875ec752cf8261dd7e6ba42570f01afc863318cc43':
    'e4155ba8cdb341dba55b1e536d3741b905d2cfc05ff1656c9c4f2c4212c42c4f',
  '394937067b8a85ae57b41b88b82f584c048b5718a521dd14dcb64dfa0b63c389':
    'fb20aead576a4c2cc161607c60465be5f94a116789b6b2d6ca43fc83c484167d',
  b57a45ca9b578b5965ee123553d9127c7dbd7057464cac61cc2eb2ffd3d8f457:
    'fbc069679b148a9005bf12cf0e840c4603b292b17ef3b6739180aea6b0d59f4c',
  a3cf85acd39ee1660ef90ab4c2d6b437ba4ad2eb1ea21cf0b7d05d8145c9c69e:
    '4648520271c1228238d3c56e6ef6b724586c20fd81d21216c2f810c6b92b348d',
  '15e55cfdaf7fcc521db98464b23c2cba595dd3abbb05c5817b7a9a6653e92b17':
    '9acd19648ea310ee8365b9e738a8dfee7a73ccc6b4c4b6d9e7fa0672fdae4adc',
  c5560376bb89c59e668a0a5e7169ba705b9e3f66aadf639acf18991ac7d5110d:
    'f742da4f9a1e693a52fd051cc21792b897125c03d6e33d9c9df7244c4def4f1a',
  '13ce88da25ceac20965ed931d0c7c8ff82aee96f6c52d0f9e2d0080ac5f25518':
    '724594d142389a24bc81d30448061d19211a09a2b2c40bf820b8f4cd1d095e15',
  '29d3fa8795d668dfb86db0fa68887b369eaa4a35a96e4ef7715db59be32183ce':
    '1b3aa7086889ac71cac00399cd2bc0dbd91150eff1c3017c57a00306ac674d95',
  '730524b20a15e57eb277e6bd6cfbfc8b3628febdbff27804b73f80c4abbf0f7b':
    '639ca24bd563d6b40dd4ef1c1e70642a47618adb686af7d3fa12eadd4518a136',
  a89e77ff19d33470c257a1f66a801b68ea2596862e05caa50f5093ad1f7bc41b:
    'f6733e2b7e84a827735e6ff54d96baf7347e8efa58eafdf5d62d2bc3ced23df8',
  a97bfcb6659459f87ae16b25dc24bd1cc6112f1d25bb9329313afc890e19f37c:
    'f1aeb7b0560ff1da5a7f3ab2f881c7950413fe5505a14c8e7e8be41b98144ad4',
  '5af9d71151c7cd80a808c359b47ece9a82d9b425229b85decceefe087d302e63':
    '65a92eada7dc10dbb8df78b4d767ee2e74045591c0df5baa918427a8a90005c1',
  '9d57dca05f76d91ae1834881fedc5d8e301d464e402d279568f4603613288955':
    '2a0e380e24eeeb61598f1f0ac6c0c04c440855ce373c8b01e1dd613d08ff66ac',
  '47b5f5c8b31b4093493edf85d6b4c7a325a5b135910169c85b1dcf2e81093161':
    'f125c61b694524d3231fd322fb31308b26d6964f4146da5ffa720ea4dad77410',
  '1f748d181fbc49233810d649f84443569a41fdab7d17ddbe81be06e272a57dd3':
    '031ff8cc8b0cd2917e320599a72f59895c929265b719d98c5b68eb92889fc6c7',
  be6b96ca6bd982f01be0107ee7d57cdcf75ceb48c29a629e1f12a52be2a18608:
    '427f3e0b268db7eae2894e1cefe588fa13b73a3f32bd5fca0d6e0ae1d9c50a42',
  f11e0d1170a2f1ed189a31c488baad0ccde5ea71d1b83b343fc2444d2fbdbd08:
    '8302f62318999916ea86772a4a1afa05d9bec1660d5b78b155b10095f2730b63',
  ea866faaa1e03bbd48da86b1d8dfd3cd7033a34748d65fc7bd377b588dfb9a6f:
    '9d8efbd9a6082c3bd37e26ec9c3937b1ebfee9efa4a96ae062cc8c9a1dca6336',
  d1a511520e04f3145d32b7e447bb0773d8e4f18d16c292646c82a86ea9be0c18:
    'd70a32932af4f1d7d216859a3b1ba5765d5c977799f1a05f0bdf6d8d250a5fcf',
  '998759123c474fd9239d477f5b52bcd97dc47b8842d9823a542eb649b0a279fb':
    'd70a32932af4f1d7d216859a3b1ba5765d5c977799f1a05f0bdf6d8d250a5fcf',
  acbd22e078a684646ac051ca3f3a71c0be325f9cd20bb4c0c5e61fc1ab847af3:
    'd70a32932af4f1d7d216859a3b1ba5765d5c977799f1a05f0bdf6d8d250a5fcf',
  '5ec673e8fd97e1dd452250ac556387f4f0acb7c1318ab6544c787fab19b4aa22':
    '1846e9e3a5bddf792420ababf6ac5814e46de8d42347d527ef159b031224bb26',
  cf5abba051921f4265110cca4917dacb9e723ba50dfba2944f76714a587cc90e:
    'b0f16c4a8c5c694f9e907e8be4ee9d217fe104f9875e6083079ab093a429336e',
  e1e3c3391dfaad27bc22205080df9ce97e853f74c4bf45b6018211de43a51c54:
    'e99043bd53ceba0d694ac40c920a957951eb0fcb4d2d8b58bd83b1c1041ec1ea',
  '366c1147743ce9b79cc224946a6f3ebcc3cac7c9f99d1b423ae3c17ec3c7cfef':
    'e99043bd53ceba0d694ac40c920a957951eb0fcb4d2d8b58bd83b1c1041ec1ea',
  '626905695b9c393638a2c377591188caf8b07938114badb6584b9b8f72b0eb30':
    '1f3513a1cc571266990ee784d76442a047628f9323f1d76b41ea85652bdd3052',
  '1ab703550dc0ac1b3b2869ce54a206e229330429931651b8a4abe58d583ffb5d':
    '1f3513a1cc571266990ee784d76442a047628f9323f1d76b41ea85652bdd3052',
  '626a6db292ee7864efb619c170b174b29330280136fff3a2983fb01d67afb1c2':
    'acddf3da8f61818f0caad4c6697f399c30c67bdd064f1d7725ccc0aee3bdbf53',
  c8359f7504a1724bb7ead93a78deb63e874299c1b49d81101bb778eb1ce02eb4:
    '129bcef375ec76babdb01bcea0745834865e67730eeb4c039d541c8162f0c969',
};
function comparePassports(...args: Parameters<typeof currentCompare>) {
  const result = currentCompare(...args);
  expect(
    createHash('sha256').update(JSON.stringify(result)).digest('hex'),
  ).toBe(v8Golden[canonicalSha256(args)]);
  return result;
}

const report: DiscoveryReport = {
  inputUrl: 'https://example.com/path?q=1',
  origin: 'https://example.com',
  inspectedAt: '2026-01-01T00:00:00.000Z',
  ard: {
    status: 'not_found',
    discoveryUrl: 'https://example.com/.well-known/ai-catalog.json',
    durationMs: 1,
    redirects: [],
    warnings: [],
  },
  a2a: {
    status: 'not_found',
    discoveryUrl: 'https://example.com/.well-known/agent-card.json',
    durationMs: 1,
    redirects: [],
    warnings: [],
  },
  mcp: {
    totalDeclared: 0,
    totalInspected: 0,
    totalOmitted: 0,
    serverCards: [],
    candidates: [],
  },
};
const base = normalizeDiscoveryReport(report);
function passport(change: (draft: AgentPassport) => void): AgentPassport {
  const draft = structuredClone(base);
  change(draft);
  draft.capabilities.sort((a, b) => a.id.localeCompare(b.id, 'en'));
  draft.inventoryGroups.sort((a, b) => a.id.localeCompare(b.id, 'en'));
  draft.endpoints.sort((a, b) => a.id.localeCompare(b.id, 'en'));
  draft.fingerprints.passport.value = canonicalSha256({
    schemaVersion: draft.schemaVersion,
    protocols: draft.protocols,
    endpoints: draft.endpoints,
    inventoryGroups: draft.inventoryGroups,
    capabilities: draft.capabilities,
    identityAssertions: draft.identityAssertions,
    consistency: draft.consistency,
  });
  return draft;
}
const endpoint = {
  id: 'endpoint:mcp',
  protocol: 'mcp' as const,
  role: 'mcp.streamable-http' as const,
  url: 'https://example.com/mcp',
  originRelationship: 'same_origin' as const,
  relationship: 'explicitly_inspected' as const,
  declarationSources: ['user_supplied'],
  observationStatus: 'valid',
  protocolVersion: '2025-11-25',
  artifactRefs: [],
};
const group = (kind: 'mcp.tool' | 'mcp.resource', complete = true) => ({
  id: `inventory:${kind}`,
  kind,
  sourceRef: endpoint.id,
  sourceEndpointId: endpoint.id,
  attempted: true,
  complete,
  itemCount: 1,
  ...(!complete ? { truncatedReason: 'item_limit' } : {}),
});
const tool = (
  name: string,
  description = 'description',
  input = 'a',
  output = 'b',
) => ({
  id: `capability:${name}`,
  kind: 'mcp.tool' as const,
  protocol: 'mcp' as const,
  protocolKey: name,
  name,
  description,
  sourceRef: endpoint.id,
  sourceEndpointId: endpoint.id,
  metadata: { name, inputSchemaSha256: input, outputSchemaSha256: output },
  inventory: { complete: true },
  fingerprint: {
    algorithm: 'sha256' as const,
    canonicalization: 'RFC8785' as const,
    projectionVersion: 'capability-semantic-v4' as const,
    value: canonicalSha256(name),
  },
  provenance: [endpoint.id],
});
const configured = (tools = [tool('alpha')], complete = true) =>
  passport((p) => {
    p.endpoints.push(structuredClone(endpoint));
    p.protocols.find((x) => x.protocol === 'mcp')!.status = 'valid';
    p.protocols.find((x) => x.protocol === 'mcp')!.revision = '2025-11-25';
    p.protocols.find((x) => x.protocol === 'mcp')!.endpointRefs = [endpoint.id];
    p.inventoryGroups.push({
      ...group('mcp.tool', complete),
      itemCount: tools.length,
    });
    p.capabilities.push(...tools);
  });
const codes = (a: AgentPassport, b: AgentPassport) =>
  comparePassports(a, b).changes.map((change) => [
    change.code,
    change.classification,
  ]);

describe('deterministic Passport drift', () => {
  it('does not manufacture breaking drift when equivalent ARD publication moves to v0.91', () => {
    const predecessor: DiscoveryReport = {
      ...report,
      ard: {
        status: 'valid',
        discoveryUrl: 'https://example.com/.well-known/ai-catalog.json',
        durationMs: 1,
        redirects: [],
        warnings: [],
        validation: {
          valid: true,
          schemaName: 'ARD predecessor',
          schemaVersion: '0.9',
          schemaRevision: 'old',
          schemaFile: 'old',
          schemaSha256: 'old',
          errors: [],
        },
        summary: {
          specVersion: '1.0',
          entries: 0,
          entryTypes: [],
          hostPresent: false,
          ardVersion: 'predecessor',
          predecessorFallbackUsed: true,
          conformanceWarnings: [],
          mcpServerCardUrls: [],
          mcpServerCardInline: [],
          declarations: [],
        },
      },
    };
    const current: DiscoveryReport = {
      ...report,
      ard: {
        ...predecessor.ard,
        discoveryUrl: 'https://example.com/.well-known/ard.json',
        validation: {
          ...predecessor.ard.validation!,
          schemaName: 'ARD v0.91',
          schemaVersion: 'v0.91',
          schemaRevision: 'new',
        },
        summary: {
          ...predecessor.ard.summary!,
          specVersion: 'v0.91',
          ardVersion: 'v0.91',
          predecessorFallbackUsed: false,
        },
      },
    };
    const result = comparePassports(
      normalizeDiscoveryReport(predecessor),
      normalizeDiscoveryReport(current),
    );
    expect(
      result.changes.some((change) => change.classification === 'breaking'),
    ).toBe(false);
    expect(result.changes.map((change) => change.code)).not.toEqual(
      expect.arrayContaining([
        'CAPABILITY_REMOVED',
        'PROTOCOL_SURFACE_REMOVED',
      ]),
    );
  });
  it('classifies complete capability additions and removals', () => {
    expect(codes(configured([]), configured())).toContainEqual([
      'CAPABILITY_ADDED',
      'non_breaking',
    ]);
    expect(codes(configured(), configured([]))).toContainEqual([
      'CAPABILITY_REMOVED',
      'breaking',
    ]);
  });
  it('suppresses false removals when the current inventory is incomplete', () => {
    const result = codes(configured(), configured([], false));
    expect(result).toContainEqual([
      'INVENTORY_COMPARISON_INDETERMINATE',
      'indeterminate',
    ]);
    expect(result.some(([code]) => code === 'CAPABILITY_REMOVED')).toBe(false);
  });
  it('suppresses false additions when the previous inventory is incomplete', () => {
    const result = codes(configured([], false), configured());
    expect(result).toContainEqual([
      'INVENTORY_COMPARISON_INDETERMINATE',
      'indeterminate',
    ]);
    expect(result.some(([code]) => code === 'CAPABILITY_ADDED')).toBe(false);
  });
  it('isolates completeness by inventory group', () => {
    const before = configured([], true);
    const after = configured([tool('new')], true);
    before.inventoryGroups.push(group('mcp.resource', true));
    after.inventoryGroups.push(group('mcp.resource', false));
    const result = codes(
      passport((p) => Object.assign(p, before)),
      passport((p) => Object.assign(p, after)),
    );
    expect(result).toContainEqual(['CAPABILITY_ADDED', 'non_breaking']);
    expect(result).toContainEqual([
      'INVENTORY_COMPARISON_INDETERMINATE',
      'indeterminate',
    ]);
  });
  it('keeps MCP input and output schema hash changes indeterminate', () => {
    expect(
      codes(
        configured(),
        configured([tool('alpha', 'description', 'changed', 'b')]),
      ),
    ).toContainEqual(['MCP_TOOL_INPUT_SCHEMA_CHANGED', 'indeterminate']);
    expect(
      codes(
        configured(),
        configured([tool('alpha', 'description', 'a', 'changed')]),
      ),
    ).toContainEqual(['MCP_TOOL_OUTPUT_SCHEMA_CHANGED', 'indeterminate']);
  });
  it('uses persisted bounded projections for directional v2 schema findings', () => {
    const projectedTool = (
      inputSchema: unknown,
      outputSchema: unknown,
      inputHash: string,
      outputHash: string,
    ) => {
      const value = tool('alpha', 'description', inputHash, outputHash);
      Object.assign(value.metadata, {
        inputSchemaCompatibility: projectJsonSchema(inputSchema),
        outputSchemaCompatibility: projectJsonSchema(outputSchema),
      });
      return value;
    };
    const previous = configured([
      projectedTool(
        { type: 'number' },
        { type: 'number' },
        'input-number',
        'output-number',
      ),
    ]);
    const current = configured([
      projectedTool(
        { type: 'integer' },
        { type: 'integer' },
        'input-integer',
        'output-integer',
      ),
    ]);
    const first = comparePassports(previous, current);
    expect(first.ruleVersion).toBe('compatibility-rules-v8');
    expect(first.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'MCP_TOOL_INPUT_SCHEMA_CHANGED',
          classification: 'breaking',
          path: '$/type',
          reasonCode: 'TYPE_SET_RESTRICTED',
        }),
        expect.objectContaining({
          code: 'MCP_TOOL_OUTPUT_SCHEMA_CHANGED',
          classification: 'non_breaking',
          path: '$/type',
          reasonCode: 'TYPE_SET_RESTRICTED',
        }),
      ]),
    );
    const second = comparePassports(previous, current);
    expect(second.changes).toEqual(first.changes);
    expect(second.changeSetFingerprint).toEqual(first.changeSetFingerprint);
  });
  it('treats description-only changes as informational', () =>
    expect(
      codes(configured(), configured([tool('alpha', 'new description')])),
    ).toContainEqual(['CAPABILITY_METADATA_CHANGED', 'informational']));
  it('classifies endpoint removal but not failure as removal', () => {
    const removed = codes(
      configured(),
      passport(() => {}),
    );
    expect(removed).toContainEqual(['ENDPOINT_REMOVED', 'breaking']);
    expect(removed).toContainEqual(['PROTOCOL_SURFACE_REMOVED', 'breaking']);
    const failed = passport((p) => {
      p.protocols.find((x) => x.protocol === 'mcp')!.status = 'unreachable';
    });
    const result = codes(configured(), failed);
    expect(result).toContainEqual([
      'ENDPOINT_OBSERVATION_FAILED',
      'indeterminate',
    ]);
    expect(result.some(([code]) => code === 'ENDPOINT_REMOVED')).toBe(false);
    expect(result.some(([code]) => code === 'PROTOCOL_SURFACE_REMOVED')).toBe(
      false,
    );
  });
  it.each([
    ['auth_required', 'ACCESS_NOW_REQUIRES_AUTH', 'breaking'],
    ['forbidden', 'ACCESS_NOW_FORBIDDEN', 'breaking'],
    ['payment_required', 'ACCESS_NOW_REQUIRES_PAYMENT', 'breaking'],
  ] as const)(
    'classifies public to %s access',
    (status, code, classification) => {
      const after = configured();
      after.endpoints[0]!.observationStatus = status;
      after.fingerprints.passport.value = canonicalSha256(after.endpoints);
      expect(codes(configured(), after)).toContainEqual([code, classification]);
    },
  );
  it.each(['auth_required', 'forbidden', 'payment_required'])(
    'classifies %s becoming publicly observable as non-breaking',
    (status) => {
      const before = configured();
      before.endpoints[0]!.observationStatus = status;
      before.fingerprints.passport.value = canonicalSha256(before.endpoints);
      expect(codes(before, configured())).toContainEqual([
        'ACCESS_BECAME_PUBLICLY_OBSERVABLE',
        'non_breaking',
      ]);
    },
  );
  it.each([
    ['unreachable', 'payment_required'],
    ['auth_required', 'payment_required'],
    ['payment_required', 'forbidden'],
  ])('leaves %s to %s as an indeterminate state change', (from, to) => {
    const before = configured();
    before.endpoints[0]!.observationStatus = from;
    before.fingerprints.passport.value = canonicalSha256(before.endpoints);
    const after = configured();
    after.endpoints[0]!.observationStatus = to;
    after.fingerprints.passport.value = canonicalSha256(after.endpoints);
    const result = codes(before, after);
    expect(result).toContainEqual([
      'ENDPOINT_OBSERVATION_STATE_CHANGED',
      'indeterminate',
    ]);
    expect(result.some(([, c]) => c === 'breaking')).toBe(false);
  });
  it('defaults protocol version changes to indeterminate', () => {
    const after = configured();
    after.endpoints[0]!.protocolVersion = 'next';
    after.fingerprints.passport.value = canonicalSha256(after.endpoints);
    expect(codes(configured(), after)).toContainEqual([
      'PROTOCOL_VERSION_CHANGED',
      'indeterminate',
    ]);
  });
  it('records identity and consistency changes as informational', () => {
    const before = configured();
    before.consistency.findings.push({
      code: 'ARD_DECLARED_MCP_SERVER_CARD',
      status: 'match',
      subjectRefs: [],
      evidenceRefs: [],
      message: 'match',
    });
    const after = structuredClone(before);
    after.identityAssertions.push({
      id: 'identity:x',
      sourceProtocol: 'mcp',
      sourceRef: endpoint.id,
      assertionType: 'implementation_identity',
      field: 'version',
      value: '2',
      trust: 'self_reported',
    });
    after.consistency.findings[0]!.status = 'mismatch';
    after.fingerprints.passport.value = canonicalSha256({
      identity: after.identityAssertions,
      consistency: after.consistency,
    });
    before.fingerprints.passport.value = canonicalSha256({
      identity: before.identityAssertions,
      consistency: before.consistency,
    });
    const result = codes(before, after);
    expect(result).toContainEqual([
      'IDENTITY_ASSERTION_CHANGED',
      'informational',
    ]);
    expect(result).toContainEqual([
      'CONSISTENCY_FINDING_CHANGED',
      'informational',
    ]);
  });
  it('uses an indeterminate safety net for otherwise unexplained semantic drift', () => {
    const after = structuredClone(base);
    after.fingerprints.passport.value = 'f'.repeat(64);
    expect(codes(base, after)).toEqual([
      ['UNCLASSIFIED_SEMANTIC_CHANGE', 'indeterminate'],
    ]);
  });
  it('never reads an oversized error body reclassified from unreachable to not found as a removal', () => {
    // Previously an oversized 404 body failed as RESPONSE_TOO_LARGE.
    const failure = {
      code: 'RESPONSE_TOO_LARGE' as const,
      message: 'Response exceeds the byte limit.',
    };
    const before = normalizeDiscoveryReport({
      ...report,
      ard: {
        ...report.ard,
        status: 'unreachable',
        discoveryUrl: 'https://example.com/.well-known/ard.json',
        error: failure,
      },
      a2a: { ...report.a2a, status: 'unreachable', error: failure },
    });
    expect(comparePassports(before, base).highestClassification).toBe(
      'indeterminate',
    );
    expect(codes(before, base)).toEqual([
      ['UNCLASSIFIED_SEMANTIC_CHANGE', 'indeterminate'],
    ]);
  });
  it('is deterministic across equivalent array and object ordering', () => {
    const previous = configured([tool('b'), tool('a')]);
    const current = configured([tool('c')]);
    const reorderedPrevious = structuredClone(previous),
      reorderedCurrent = structuredClone(current);
    reorderedPrevious.capabilities.reverse();
    reorderedPrevious.inventoryGroups.reverse();
    reorderedCurrent.capabilities.reverse();
    reorderedCurrent.inventoryGroups.reverse();
    const first = comparePassports(previous, current),
      second = comparePassports(reorderedPrevious, reorderedCurrent);
    expect(second.changes).toEqual(first.changes);
    expect(second.changeSetFingerprint).toEqual(first.changeSetFingerprint);
    expect(first.ruleVersion).toBe('compatibility-rules-v8');
  });
  it('stops at incompatible representation versions', () => {
    const prior = { ...base, schemaVersion: '0.1.0' };
    const result = comparePassports(prior, base);
    expect(result.state).toBe('incompatible_version');
    expect(result.changes).toEqual([]);
  });
  it('classifies directional OpenAPI request and response schemas through projection v1', () => {
    const make = (
      requestType: 'number' | 'integer',
      responseType: 'number' | 'integer',
    ) =>
      passport((p) => {
        p.protocols.find((x) => x.protocol === 'openapi')!.status = 'valid';
        p.inventoryGroups.push({
          id: 'inventory:openapi',
          kind: 'openapi.operation',
          sourceRef: 'artifact:openapi',
          attempted: true,
          complete: true,
          itemCount: 1,
        });
        p.capabilities.push({
          id: 'capability:openapi:post-items',
          kind: 'openapi.operation',
          protocol: 'openapi',
          protocolKey: 'POST /items',
          name: 'createItem',
          sourceRef: 'artifact:openapi',
          metadata: {
            method: 'POST',
            path: '/items',
            parameters: [],
            requestBody: {
              required: false,
              content: [
                {
                  mediaType: 'application/json',
                  schemaSha256: requestType,
                  schemaCompatibility: projectJsonSchema({ type: requestType }),
                },
              ],
            },
            responses: [
              {
                statusKey: '200',
                content: [
                  {
                    mediaType: 'application/json',
                    schemaSha256: responseType,
                    schemaCompatibility: projectJsonSchema({
                      type: responseType,
                    }),
                  },
                ],
              },
            ],
          },
          inventory: { complete: true },
          fingerprint: {
            algorithm: 'sha256',
            canonicalization: 'RFC8785',
            projectionVersion: 'capability-semantic-v4',
            value: canonicalSha256({ requestType, responseType }),
          },
          provenance: ['artifact:openapi'],
        });
      });
    const result = codes(make('number', 'number'), make('integer', 'integer'));
    expect(result).toContainEqual([
      'OPENAPI_REQUEST_SCHEMA_CHANGED',
      'breaking',
    ]);
    expect(result).toContainEqual([
      'OPENAPI_RESPONSE_SCHEMA_CHANGED',
      'non_breaking',
    ]);
  });

  it('classifies OpenAPI requiredness and suppresses operation removals for incomplete inventory', () => {
    const make = (required: boolean, complete = true) =>
      passport((p) => {
        p.protocols.find((x) => x.protocol === 'openapi')!.status = 'valid';
        p.inventoryGroups.push({
          id: 'inventory:openapi',
          kind: 'openapi.operation',
          sourceRef: 'artifact:openapi',
          attempted: true,
          complete,
          itemCount: 1,
          ...(!complete ? { truncatedReason: 'operation_limit' } : {}),
        });
        p.capabilities.push({
          id: 'capability:openapi:get-items',
          kind: 'openapi.operation',
          protocol: 'openapi',
          protocolKey: 'GET /items',
          name: 'listItems',
          sourceRef: 'artifact:openapi',
          metadata: {
            method: 'GET',
            path: '/items',
            parameters: [
              {
                key: 'query:limit',
                required,
                schemaSha256: 'same',
                schemaCompatibility: projectJsonSchema({ type: 'integer' }),
              },
            ],
            responses: [],
          },
          inventory: { complete },
          fingerprint: {
            algorithm: 'sha256',
            canonicalization: 'RFC8785',
            projectionVersion: 'capability-semantic-v4',
            value: canonicalSha256(required),
          },
          provenance: ['artifact:openapi'],
        });
      });
    expect(codes(make(false), make(true))).toContainEqual([
      'OPENAPI_PARAMETER_REQUIREDNESS_CHANGED',
      'breaking',
    ]);
    const current = make(false, false);
    current.capabilities = [];
    current.fingerprints.passport.value = canonicalSha256(current);
    const comparison = comparePassports(make(false), current);
    expect(
      comparison.changes.some(
        (item) => item.code === 'OPENAPI_OPERATION_REMOVED',
      ),
    ).toBe(false);
    expect(
      comparison.changes.some(
        (item) => item.code === 'INVENTORY_COMPARISON_INDETERMINATE',
      ),
    ).toBe(true);
  });

  it('does not fabricate OpenAPI addition across the 0.3.0 representation boundary', () => {
    const prior = structuredClone(base) as unknown as Record<string, unknown>;
    prior.schemaVersion = '0.3.0';
    const fingerprints = prior.fingerprints as {
      passport: { projectionVersion: string };
    };
    fingerprints.passport.projectionVersion = 'passport-semantic-v2';
    const current = passport((p) => {
      p.protocols.find((x) => x.protocol === 'openapi')!.status = 'valid';
    });
    const comparison = comparePassports(prior, current);
    expect(comparison.state).toBe('incompatible_version');
    expect(comparison.changes).toEqual([]);
  });
});

describe('compatibility-rules-v5 WebMCP drift', () => {
  const site = (html?: string, failed = false): AgentPassport => {
    const observed =
      html === undefined
        ? undefined
        : extractWebMcpDeclarativeTools(
            html,
            new URL(report.origin),
            `${report.origin}/`,
          );
    return normalizeDiscoveryReport({
      ...report,
      webmcp:
        observed && failed
          ? {
              ...observed,
              status: 'not_observed',
              reason: 'unreachable',
              tools: [],
              toolCount: 0,
            }
          : observed,
    });
  };
  const book =
    '<form toolname="book" tooldescription="Book"><input name="date"></form>';
  const search = '<form toolname="search"><input name="q"></form>';
  const none = '<main>No tools</main>';

  it('adds WebMCP as a non-breaking surface with no inventory noise', () => {
    const result = comparePassports(site(none), site(book));
    expect(result.changes.map((c) => [c.code, c.classification])).toEqual([
      ['PROTOCOL_SURFACE_ADDED', 'non_breaking'],
    ]);
    expect(result.ruleVersion).toBe('compatibility-rules-v8');
  });
  it('classifies tool removal and addition only between complete inventories', () => {
    expect(codes(site(book + search), site(book))).toContainEqual([
      'CAPABILITY_REMOVED',
      'breaking',
    ]);
    expect(codes(site(book), site(book + search))).toContainEqual([
      'CAPABILITY_ADDED',
      'non_breaking',
    ]);
    const duplicated = site(book + book.replace('date', 'day'));
    const suppressed = codes(site(book + search), duplicated);
    expect(suppressed).toContainEqual([
      'INVENTORY_COMPARISON_INDETERMINATE',
      'indeterminate',
    ]);
    expect(suppressed.some(([code]) => code === 'CAPABILITY_REMOVED')).toBe(
      false,
    );
  });
  it.each([
    ['a complete root page without tools', () => site(none)],
    ['a failed root page fetch', () => site(none, true)],
  ])(
    'never claims removal when declarations vanish after %s',
    (_label, after) => {
      const result = codes(site(book), after());
      expect(result).toEqual([
        ['WEBMCP_DECLARATIONS_NOT_OBSERVED', 'indeterminate'],
      ]);
    },
  );
  it('treats declared form-field changes as indeterminate, not metadata noise', () => {
    const result = codes(
      site(book),
      site(
        '<form toolname="book" tooldescription="Book"><input name="date"><input name="party" required></form>',
      ),
    );
    expect(result).toEqual([['WEBMCP_TOOL_CONTROLS_CHANGED', 'indeterminate']]);
  });
  it('keeps description changes informational', () => {
    expect(
      codes(
        site(book),
        site(
          book.replace('tooldescription="Book"', 'tooldescription="Reserve"'),
        ),
      ),
    ).toEqual([['CAPABILITY_METADATA_CHANGED', 'informational']]);
  });
  it('leaves sites without WebMCP unchanged across root page failures', () => {
    expect(comparePassports(site(none), site(none, true)).state).toBe(
      'unchanged',
    );
    expect(comparePassports(site(), site(none)).state).toBe('unchanged');
  });
  it('treats a retained 0.4.0 Passport as incompatible and emits nothing', () => {
    const current = site(book);
    const prior = {
      ...current,
      schemaVersion: '0.4.0',
      fingerprints: {
        passport: {
          ...current.fingerprints.passport,
          projectionVersion: 'passport-semantic-v3',
        },
      },
    };
    const result = comparePassports(prior, current);
    expect(result.state).toBe('incompatible_version');
    expect(result.changes).toEqual([]);
    expect(result.highestClassification).toBe('none');
  });
});

describe('compatibility-rules-v6 OpenAPI payment declarations', () => {
  const offer = (method = 'tempo', intent = 'charge') => ({
    intent,
    method,
    currency: 'usd',
    pricing: 'fixed',
  });
  const summary = (
    offers = [offer()],
    offersTruncated = false,
    declares402Response = true,
  ) => ({
    offers,
    offersTruncated,
    declares402Response,
    rejectionCodes: [],
  });
  const operation = (
    payment: ReturnType<typeof summary> | undefined,
    {
      groupComplete = true,
      capabilityComplete = true,
      title = 'List items',
      checked = true,
    } = {},
  ) =>
    passport((p) => {
      p.protocols.find((x) => x.protocol === 'openapi')!.status = 'valid';
      p.inventoryGroups.push({
        id: 'inventory:openapi',
        kind: 'openapi.operation',
        sourceRef: 'artifact:openapi',
        attempted: true,
        complete: groupComplete,
        itemCount: 1,
        ...(!groupComplete ? { truncatedReason: 'operation_limit' } : {}),
      });
      p.capabilities.push({
        id: 'capability:openapi:get-items',
        kind: 'openapi.operation',
        protocol: 'openapi',
        protocolKey: 'GET /items',
        name: 'listItems',
        title,
        sourceRef: 'artifact:openapi',
        metadata: {
          method: 'GET',
          path: '/items',
          parameters: [],
          responses: [],
          ...(checked ? { paymentDeclaration: payment ?? null } : {}),
        },
        inventory: { complete: capabilityComplete },
        fingerprint: {
          algorithm: 'sha256',
          canonicalization: 'RFC8785',
          projectionVersion: 'capability-semantic-v4',
          value: canonicalSha256({ payment: payment ?? null, title }),
        },
        provenance: ['artifact:openapi'],
      });
    });
  const paymentCodes = (a: AgentPassport, b: AgentPassport) =>
    codes(a, b).filter(
      ([code]) =>
        code.includes('PAYMENT') || code === 'CAPABILITY_METADATA_CHANGED',
    );

  it('classifies a newly declared payment requirement as breaking', () =>
    expect(paymentCodes(operation(undefined), operation(summary()))).toEqual([
      ['OPENAPI_OPERATION_NOW_REQUIRES_PAYMENT', 'breaking'],
    ]));

  it('classifies a withdrawn payment requirement as non-breaking', () =>
    expect(paymentCodes(operation(summary()), operation(undefined))).toEqual([
      ['OPENAPI_OPERATION_NO_LONGER_REQUIRES_PAYMENT', 'non_breaking'],
    ]));

  it('leaves a changed declaration indeterminate', () =>
    expect(
      paymentCodes(
        operation(summary([offer('tempo')])),
        operation(summary([offer('stripe')])),
      ),
    ).toEqual([['OPENAPI_PAYMENT_DECLARATION_CHANGED', 'indeterminate']]));

  it.each([
    ['incomplete operation inventory', { groupComplete: false }, false],
    ['incomplete operation evidence', { capabilityComplete: false }, false],
    ['truncated offers', {}, true],
  ] as const)(
    'never claims a new requirement from %s',
    (_label, flags, truncated) => {
      const result = comparePassports(
        operation(undefined, flags),
        operation(summary([offer()], truncated), flags),
      ).changes.filter((change) => change.code.includes('PAYMENT'));
      expect(result.map((change) => change.classification)).toEqual([
        'indeterminate',
      ]);
      expect(result[0]!.reasonCode).toBe('PAYMENT_EVIDENCE_INCOMPLETE');
    },
  );

  it('does not claim a requirement from a declaration without a usable offer', () =>
    expect(
      paymentCodes(
        operation(undefined),
        operation(summary([{ ...offer(), method: '' }])),
      ),
    ).toEqual([['OPENAPI_PAYMENT_DECLARATION_CHANGED', 'indeterminate']]));

  it('reports payment through the v6 rule, not as generic metadata', () => {
    const result = paymentCodes(
      operation(undefined, { title: 'Old title' }),
      operation(summary(), { title: 'New title' }),
    );
    expect(result).toContainEqual([
      'OPENAPI_OPERATION_NOW_REQUIRES_PAYMENT',
      'breaking',
    ]);
    const metadata = comparePassports(
      operation(undefined, { title: 'Old title' }),
      operation(summary(), { title: 'New title' }),
    ).changes.find((change) => change.code === 'CAPABILITY_METADATA_CHANGED');
    expect(metadata).toBeDefined();
    expect(JSON.stringify(metadata)).not.toContain('paymentDeclaration');
  });

  it('explains an observer that began reading declarations as one informational event, never breaking', () => {
    const result = comparePassports(
      operation(undefined, { checked: false }),
      operation(summary()),
    );
    expect(
      result.changes.map((change) => [change.code, change.classification]),
    ).toEqual([
      ['OPENAPI_PAYMENT_DECLARATION_COVERAGE_CHANGED', 'informational'],
    ]);
    expect(result.changes[0]!.entityId).toBe(
      'artifact:openapi|openapi.operation',
    );
  });

  it('does not call a declaration without a 402 response breaking', () => {
    const result = comparePassports(
      operation(undefined),
      operation(summary([offer()], false, false)),
    ).changes.filter((change) => change.code.includes('PAYMENT'));
    expect(
      result.map((change) => [change.code, change.classification]),
    ).toEqual([['OPENAPI_PAYMENT_DECLARATION_CHANGED', 'indeterminate']]);
    expect(result[0]!.reasonCode).toBe('PAYMENT_DECLARED_WITHOUT_402_RESPONSE');
  });

  it('emits one coverage event per document however many operations it holds', () => {
    const twoOperations = (
      payment: ReturnType<typeof summary> | undefined,
      checked: boolean,
    ) => {
      const p = operation(payment, { checked });
      const first = p.capabilities.find(
        (c) => c.id === 'capability:openapi:get-items',
      )!;
      p.capabilities.push({
        ...structuredClone(first),
        id: 'capability:openapi:post-items',
        protocolKey: 'POST /items',
        name: 'createItem',
      });
      p.inventoryGroups.find((g) => g.id === 'inventory:openapi')!.itemCount =
        2;
      p.fingerprints.passport.value = canonicalSha256({
        checked,
        payment: payment ?? null,
      });
      return p;
    };
    const coverage = comparePassports(
      twoOperations(undefined, false),
      twoOperations(summary(), true),
    ).changes.filter(
      (change) =>
        change.code === 'OPENAPI_PAYMENT_DECLARATION_COVERAGE_CHANGED',
    );
    expect(coverage).toHaveLength(1);
  });

  it('emits nothing when only an unchanged declaration is present', () =>
    expect(paymentCodes(operation(summary()), operation(summary()))).toEqual(
      [],
    ));
});

describe('compatibility-rules-v7 WebMCP page-target drift', () => {
  const pagePath = '/checkout';
  const target = (rootHtml: string, pageHtml?: string): AgentPassport => {
    const root = extractWebMcpDeclarativeTools(
      rootHtml,
      new URL(report.origin),
      `${report.origin}/`,
    );
    const submittedPage =
      pageHtml === undefined
        ? undefined
        : extractWebMcpDeclarativeTools(
            pageHtml,
            new URL(`${report.origin}${pagePath}`),
            `${report.origin}${pagePath}`,
            'submitted_page_html_declarative_forms',
          );
    return normalizeDiscoveryReport(
      { ...report, webmcp: { ...root, submittedPage } } as DiscoveryReport,
      { monitoredPage: pagePath },
    );
  };
  const root = '<form toolname="book"><input name="date"></form>';
  const pay = '<form toolname="pay"><input name="card"></form>';
  const refund = '<form toolname="refund"><input name="id"></form>';
  const pairs = (a: AgentPassport, b: AgentPassport) =>
    comparePassports(a, b).changes.map((c) => [c.code, c.classification]);

  it('reports a watched page starting to declare tools as non-breaking', () =>
    expect(pairs(target(root), target(root, pay))).toEqual([
      ['WEBMCP_DECLARATIONS_OBSERVED', 'non_breaking'],
    ]));

  it('never claims removal when a watched page stops showing tools', () => {
    for (const after of [target(root), target(root, '<p>none</p>')]) {
      const changes = pairs(target(root, pay), after);
      expect(changes).toEqual([
        ['WEBMCP_DECLARATIONS_NOT_OBSERVED', 'indeterminate'],
      ]);
    }
  });

  it('applies complete-inventory tool rules per page artifact', () => {
    expect(pairs(target(root, pay + refund), target(root, pay))).toEqual([
      ['CAPABILITY_REMOVED', 'breaking'],
    ]);
    expect(pairs(target(root, pay), target(root, pay + refund))).toEqual([
      ['CAPABILITY_ADDED', 'non_breaking'],
    ]);
  });

  it('keeps the protocol rule for a page-target whose only tools vanish', () =>
    expect(
      pairs(target('<p>none</p>', pay), target('<p>none</p>', '<p>none</p>')),
    ).toEqual([['WEBMCP_DECLARATIONS_NOT_OBSERVED', 'indeterminate']]));
});

describe('compatibility-rules-v8 unread discovery sources', () => {
  const card = {
    id: 'artifact:card',
    kind: 'mcp.server-card.experimental' as const,
    protocol: 'mcp-server-card' as const,
    url: 'https://example.com/.well-known/mcp/server-card.json',
    status: 'valid',
    validationStatus: 'valid' as const,
    provenance: ['discovery:ard'],
  };
  const status = (p: AgentPassport, protocol: string, value: string) => {
    p.protocols.find((x) => x.protocol === protocol)!.status = value;
  };
  // MCP reached through a Server Card the ARD catalog declares, plus OpenAPI.
  const discovered = passport((p) => {
    p.endpoints.push({
      ...structuredClone(endpoint),
      relationship: 'declared_and_inspected',
      declarationSources: ['server_card_declared'],
      artifactRefs: [card.id],
    });
    p.artifacts.push(structuredClone(card));
    for (const protocol of ['ard', 'mcp', 'mcp-server-card', 'openapi'])
      status(p, protocol, 'valid');
    p.inventoryGroups.push(group('mcp.tool'));
    p.capabilities.push(tool('alpha'));
  });
  const after = (ard: string, cardStatus?: string) =>
    passport((p) => {
      status(p, 'ard', ard);
      if (cardStatus) {
        p.artifacts.push({ ...structuredClone(card), status: cardStatus });
        status(p, 'mcp-server-card', 'observed');
      }
    });
  const reasons = (current: AgentPassport) =>
    comparePassports(discovered, current).changes.map((change) => [
      change.code,
      change.entityId,
      change.classification,
      change.reasonCode,
    ]);
  const unproven = 'DISCOVERY_SOURCE_NOT_OBSERVED_REMOVAL_NOT_PROVEN';

  it.each(['unreachable', 'blocked'])(
    'reports no removal when the ARD catalog is %s',
    (ard) => {
      const result = reasons(after(ard));
      expect(result.some(([, , level]) => level === 'breaking')).toBe(false);
      for (const protocol of ['mcp', 'mcp-server-card', 'openapi'])
        expect(result).toContainEqual([
          'PROTOCOL_OBSERVATION_FAILED',
          protocol,
          'indeterminate',
          unproven,
        ]);
      expect(result).toContainEqual([
        'ENDPOINT_OBSERVATION_FAILED',
        endpoint.id,
        'indeterminate',
        unproven,
      ]);
    },
  );
  it.each(['unreachable', 'blocked', 'declared_not_fetched'])(
    'reports no MCP removal when its Server Card is %s',
    (cardStatus) => {
      const result = reasons(after('valid', cardStatus));
      expect(result).toContainEqual([
        'PROTOCOL_OBSERVATION_FAILED',
        'mcp',
        'indeterminate',
        unproven,
      ]);
      expect(result).toContainEqual([
        'ENDPOINT_OBSERVATION_FAILED',
        endpoint.id,
        'indeterminate',
        unproven,
      ]);
      // The catalog answered without OpenAPI: that removal is conclusive.
      expect(result).toContainEqual([
        'OPENAPI_SURFACE_REMOVED',
        'openapi',
        'breaking',
        'PREVIOUSLY_PRESENT_CURRENTLY_CONCLUSIVELY_ABSENT',
      ]);
      expect(
        result.some(
          ([code, id]) =>
            (code === 'PROTOCOL_SURFACE_REMOVED' && id === 'mcp') ||
            code === 'ENDPOINT_REMOVED',
        ),
      ).toBe(false);
    },
  );
  it.each([
    ['not_found', undefined],
    ['invalid', undefined],
    ['valid', 'not_found'],
    ['valid', 'invalid'],
  ])(
    'keeps a publisher answer conclusive (ARD %s, card %s)',
    (ard, cardStatus) => {
      const result = reasons(after(ard, cardStatus));
      expect(result).toContainEqual([
        'PROTOCOL_SURFACE_REMOVED',
        'mcp',
        'breaking',
        'PREVIOUSLY_PRESENT_CURRENTLY_CONCLUSIVELY_ABSENT',
      ]);
      expect(result).toContainEqual([
        'ENDPOINT_REMOVED',
        endpoint.id,
        'breaking',
        'PREVIOUSLY_PRESENT_CURRENTLY_CONCLUSIVELY_ABSENT',
      ]);
      expect(result.some(([, , , reason]) => reason === unproven)).toBe(false);
    },
  );
  it('ignores a Server Card that was not read before either', () => {
    const other = {
      ...structuredClone(card),
      id: 'artifact:card-b',
      url: 'https://cards.example.net/server-card.json',
    };
    // Card B is cross-origin (never fetched) or failing on both sides; the
    // publisher drops /mcp from card A, which still answers.
    for (const status of ['declared_not_fetched', 'unreachable']) {
      const withB = (base: AgentPassport) =>
        passport((p) => {
          Object.assign(p, structuredClone(base));
          p.artifacts.push({ ...structuredClone(other), status });
          for (const item of p.endpoints)
            item.artifactRefs = [card.id, other.id];
        });
      const current = passport((p) => {
        for (const protocol of ['ard', 'mcp-server-card', 'openapi'])
          p.protocols.find((x) => x.protocol === protocol)!.status = 'valid';
        p.artifacts.push(structuredClone(card));
      });
      const result = comparePassports(
        withB(discovered),
        withB(current),
      ).changes.map((change) => [change.code, change.classification]);
      expect(result).toContainEqual(['PROTOCOL_SURFACE_REMOVED', 'breaking']);
      expect(result).toContainEqual(['ENDPOINT_REMOVED', 'breaking']);
    }
  });
  it('treats an endpoint as unproven when any card that named it is unread', () => {
    const other = { ...structuredClone(card), id: 'artifact:card-b' };
    const both = passport((p) => {
      Object.assign(p, structuredClone(discovered));
      p.artifacts.push(structuredClone(other));
      p.endpoints[0]!.artifactRefs = [card.id, other.id];
    });
    const current = passport((p) => {
      for (const protocol of ['ard', 'mcp-server-card', 'openapi'])
        p.protocols.find((x) => x.protocol === protocol)!.status = 'valid';
      p.artifacts.push(structuredClone(card), {
        ...structuredClone(other),
        status: 'unreachable',
      });
    });
    const result = comparePassports(both, current).changes.map((change) => [
      change.code,
      change.classification,
      change.reasonCode,
    ]);
    expect(result).toContainEqual([
      'ENDPOINT_OBSERVATION_FAILED',
      'indeterminate',
      unproven,
    ]);
    expect(result.some(([code]) => code === 'ENDPOINT_REMOVED')).toBe(false);
  });
  it('keeps a supplied endpoint conclusive when the catalog fails', () => {
    const result = codes(
      configured(),
      passport((p) => status(p, 'ard', 'unreachable')),
    );
    expect(result).toContainEqual(['ENDPOINT_REMOVED', 'breaking']);
  });
});
