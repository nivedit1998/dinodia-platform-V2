// Architecture: API boundary /claimFile; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { POST as claimPost } from '../claim/route';

export const runtime = 'nodejs';
export const POST = claimPost;
