import { describe, expect, it } from 'vitest';

import { getLocalePreference, normalizeLocale, setLocalePreference, t } from './i18n';

describe('i18n', () => {
  it('normalizes supported browser languages', () => {
    expect(normalizeLocale('en-US')).toBe('en');
    expect(normalizeLocale('zh-CN')).toBe('zh-CN');
    expect(normalizeLocale('zh-TW')).toBe('zh-CN');
    expect(normalizeLocale('ja-JP')).toBe('ja');
    expect(normalizeLocale('fr-FR')).toBe('en');
  });

  it('returns localized messages for core UI labels', () => {
    expect(t('workspace', 'en')).toBe('Workspace');
    expect(t('workspace', 'zh-CN')).toBe('工作区');
    expect(t('workspace', 'ja')).toBe('ワークスペース');
    expect(t('whatAiSees', 'zh-CN')).toBe('AI 会看到什么');
    expect(t('whatAiSees', 'ja')).toBe('AI が見る内容');
  });

  it('persists an explicit locale preference', () => {
    localStorage.removeItem('page-context.locale.v1');
    expect(getLocalePreference()).toBe('auto');

    setLocalePreference('ja');
    expect(getLocalePreference()).toBe('ja');

    setLocalePreference('auto');
    expect(getLocalePreference()).toBe('auto');
  });
});
