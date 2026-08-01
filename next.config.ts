import type { NextConfig } from 'next'

const config: NextConfig = {
  // `pg` is a native-ish Node client; keep it out of any bundling attempt.
  serverExternalPackages: ['pg'],
}

export default config
