// Architecture: API boundary /tenant/matter/sessions/workflow.ts; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
export { finalizeCommissioningSuccess } from '@/lib/deviceCommissioningWorkflow';
