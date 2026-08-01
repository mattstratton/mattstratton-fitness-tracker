import { handlers } from '../../../../auth.js'

// Auth.js exposes both handlers as one object; Next wants them as named
// exports. Note this lives under /api, which middleware deliberately does not
// guard -- requiring a session to reach the sign-in route is a redirect loop.
export const { GET, POST } = handlers
