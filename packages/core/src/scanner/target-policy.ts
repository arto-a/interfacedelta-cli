/**
 * The outbound target policy is owned by `@interfacedelta/common/outbound-policy`
 * so every outbound client shares one SSRF/DNS classification
 * implementation. This module is retained as the
 * scanner-facing import path.
 */
export * from '@interfacedelta/common/outbound-policy';
