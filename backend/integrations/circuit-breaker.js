/**
 * Circuit Breaker Pattern Implementation
 * Prevents cascading failures by temporarily blocking requests to failing services
 */
export class CircuitBreaker {
  constructor(threshold = 5, timeout = 60000) {
    this.failureCount = 0;
    this.threshold = threshold; // Number of failures before opening circuit
    this.timeout = timeout; // Time to wait before attempting half-open
    this.state = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
    this.nextAttempt = Date.now();
    this.successCount = 0; // Track successes in half-open state
    this.halfOpenSuccessThreshold = 2; // Need 2 successes to close circuit
  }

  /**
   * Execute a function with circuit breaker protection
   * @param {Function} fn - The function to execute
   * @returns {Promise<any>} - The result of the function
   * @throws {Error} - If circuit is open or function fails
   */
  async execute(fn) {
    // Check if circuit is open
    if (this.state === 'OPEN') {
      if (Date.now() < this.nextAttempt) {
        throw new Error(`Circuit breaker is OPEN. Service unavailable. Retry after ${Math.ceil((this.nextAttempt - Date.now()) / 1000)}s`);
      }
      // Timeout expired, try half-open
      this.state = 'HALF_OPEN';
      this.successCount = 0;
      console.log('🔓 Circuit breaker: Moving to HALF_OPEN state');
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  /**
   * Handle successful execution
   */
  onSuccess() {
    this.failureCount = 0;
    
    if (this.state === 'HALF_OPEN') {
      this.successCount++;
      // If we get enough successes in half-open, close the circuit
      if (this.successCount >= this.halfOpenSuccessThreshold) {
        this.state = 'CLOSED';
        this.successCount = 0;
        console.log('✅ Circuit breaker: Moving to CLOSED state (service recovered)');
      }
    } else if (this.state === 'OPEN') {
      // This shouldn't happen, but handle it
      this.state = 'CLOSED';
      this.failureCount = 0;
    }
  }

  /**
   * Handle failed execution
   */
  onFailure() {
    this.failureCount++;
    
    if (this.state === 'HALF_OPEN') {
      // Any failure in half-open immediately opens the circuit
      this.state = 'OPEN';
      this.nextAttempt = Date.now() + this.timeout;
      this.successCount = 0;
      console.log('❌ Circuit breaker: Moving to OPEN state (failure in half-open)');
    } else if (this.failureCount >= this.threshold) {
      // Too many failures, open the circuit
      this.state = 'OPEN';
      this.nextAttempt = Date.now() + this.timeout;
      console.log(`🔒 Circuit breaker: Moving to OPEN state (${this.failureCount} failures)`);
    }
  }

  /**
   * Get current state
   */
  getState() {
    return {
      state: this.state,
      failureCount: this.failureCount,
      nextAttempt: this.nextAttempt,
      isOpen: this.state === 'OPEN',
    };
  }

  /**
   * Manually reset the circuit breaker
   */
  reset() {
    this.state = 'CLOSED';
    this.failureCount = 0;
    this.successCount = 0;
    this.nextAttempt = Date.now();
    console.log('🔄 Circuit breaker: Manually reset');
  }
}

/**
 * Create a circuit breaker instance with custom configuration
 * @param {Object} options - Configuration options
 * @returns {CircuitBreaker} - Circuit breaker instance
 */
export function createCircuitBreaker(options = {}) {
  const {
    threshold = 5,
    timeout = 60000, // 1 minute default
  } = options;
  
  return new CircuitBreaker(threshold, timeout);
}

