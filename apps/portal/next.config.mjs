// Plain JavaScript with a JSDoc type: Next reads its config at runtime too, and a production image
// has no TypeScript compiler (the lesson Munaxa Work's portal recorded).

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  {
    key: 'Permissions-Policy',
    value: 'accelerometer=(), camera=(), geolocation=(), gyroscope=(), microphone=(), payment=()',
  },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
  // An administration console is never embedded and never cached by a shared proxy.
  { key: 'Cache-Control', value: 'private, no-store' },
];

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: 'standalone',
  transpilePackages: ['@munaxa/ui', '@munaxa/platform', '@munaxa/icons', '@munaxa/theme'],
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default config;
