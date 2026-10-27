export const ANALYTICS_CATEGORIES = ['NONE','LIGHT','RADIATOR','BOILER','SOCKET','TV','BLIND','AC','WASHING_MACHINE'] as const;
export type AnalyticsCategory = typeof ANALYTICS_CATEGORIES[number];
export const CATEGORY_ROLES:Record<AnalyticsCategory,readonly string[]> = {
  NONE:[],LIGHT:['power','brightness'],RADIATOR:['active_heat_demand'],BOILER:['active_heat_production'],
  SOCKET:['power'],TV:['power'],BLIND:['opening_percentage'],AC:['thermal_activity'],WASHING_MACHINE:['cycle_activity'],
};
export function isAnalyticsCategory(value:unknown):value is AnalyticsCategory {
  return typeof value === 'string' && (ANALYTICS_CATEGORIES as readonly string[]).includes(value);
}
export function isStateAnalyticsCategory(value:unknown) { return typeof value==='string' && ['SOCKET','TV','BLIND','AC','WASHING_MACHINE'].includes(value); }
