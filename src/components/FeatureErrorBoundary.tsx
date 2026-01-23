import React, { Component, ErrorInfo, ReactNode } from 'react';
import { logger } from '@/lib/logger';
import { FeatureErrorFallback } from './FeatureErrorFallback';

interface Props {
  children: ReactNode;
  /** Name of the feature for logging */
  featureName: string;
  /** Custom fallback component */
  fallback?: ReactNode;
  /** Callback when error occurs */
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
  /** Whether to show compact error UI */
  compact?: boolean;
  /** Callback for retry action */
  onRetry?: () => void;
  /** Callback for back navigation */
  onBack?: () => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * Feature-level error boundary for isolating errors to specific sections.
 * Use this around critical features like booking forms, payment flows, etc.
 * 
 * Example:
 * ```tsx
 * <FeatureErrorBoundary featureName="BookingForm" onRetry={() => window.location.reload()}>
 *   <BookingForm />
 * </FeatureErrorBoundary>
 * ```
 */
export class FeatureErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    const { featureName, onError } = this.props;

    // Log to centralized logger
    logger.error(`Error in ${featureName}`, error, {
      component: featureName,
      componentStack: errorInfo.componentStack || undefined,
    });

    // Call optional error callback
    onError?.(error, errorInfo);
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
    this.props.onRetry?.();
  };

  render() {
    const { hasError, error } = this.state;
    const { children, fallback, compact, featureName, onBack } = this.props;

    if (hasError) {
      if (fallback) {
        return fallback;
      }

      return (
        <FeatureErrorFallback
          error={error}
          onRetry={this.handleRetry}
          onBack={onBack}
          title={`${featureName} Error`}
          description={`There was a problem loading this section. Please try again.`}
          compact={compact}
        />
      );
    }

    return children;
  }
}

export default FeatureErrorBoundary;
