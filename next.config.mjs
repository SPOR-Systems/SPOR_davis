/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "images.unsplash.com",
      },
    ],
  },

  /**
   * Keep compiled routes in memory during development.
   *
   * Next's dev server compiles a route the first time it is requested and then
   * EVICTS it — by default after 15 seconds of not being viewed, keeping only
   * a couple of pages. That is why clicking between pages feels like the app is
   * slow: it is not loading, it is rebuilding something it already built,
   * repeatedly, all day.
   *
   * An hour and fifty entries costs some memory in dev and nothing in
   * production, where this setting does not apply at all — a production build
   * compiles everything ahead of time.
   */
  onDemandEntries: {
    maxInactiveAge: 60 * 60 * 1000,
    pagesBufferLength: 50,
  },
};

export default nextConfig;
