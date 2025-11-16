import rateLimit from 'express-rate-limit';

/**
 * General API rate limiter
 * Limits each IP to 100 requests per 15 minutes
 */
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
});

/**
 * Authentication rate limiter
 * Limits each IP to 5 login attempts per 15 minutes
 * Skips successful requests to only count failures
 */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 login attempts per 15 minutes
  skipSuccessfulRequests: true, // Don't count successful requests
  message: 'Too many authentication attempts from this IP, please try again after 15 minutes.',
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Generation endpoint rate limiter
 * Limits each IP to 20 generation requests per hour
 */
export const generationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20, // 20 generation requests per hour
  message: 'Too many generation requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

