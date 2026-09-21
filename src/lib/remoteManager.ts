// Architecture: public names for the Home Assistant dinodia_remote_manager
// service contract. Platform tenant/admin routes and the iOS remote-management
// screens use these names to discover bindings, trigger devices and targets;
// the matching HA custom integration owns the local event routing semantics.

export const REMOTE_MANAGER_DOMAIN = 'dinodia_remote_manager';
export const SERVICE_REGISTER_BINDING = 'register_binding';
export const SERVICE_SET_TRIGGER_TARGET = 'set_trigger_target';
export const SERVICE_UPDATE_BINDING = 'update_binding';
export const SERVICE_REMOVE_TENANT_BINDINGS = 'remove_tenant_bindings';
export const SERVICE_REMOVE_TRIGGER_BINDINGS_FOR_DEVICES = 'remove_trigger_bindings_for_devices';
export const SERVICE_LIST_BINDINGS = 'list_bindings';
export const SERVICE_UNBIND = 'unbind';
export const SERVICE_LIST_TRIGGER_DEVICES = 'list_trigger_devices';
export const SERVICE_LIST_TRIGGER_DEVICE_DASHBOARD = 'list_trigger_device_dashboard';
export const SERVICE_RESOLVE_BINDING = 'resolve_binding';

export const REMOTE_BINDING_READ_TIMEOUT_MS = 10000;
export const REMOTE_BINDING_UPDATE_TIMEOUT_MS = 20000;
export const REMOTE_TRIGGER_INVENTORY_TIMEOUT_MS = 30000;
