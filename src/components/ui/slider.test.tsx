import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Slider } from './slider';

describe('Slider', () => {
  it('renders a single thumb for single value', () => {
    const { container } = render(<Slider defaultValue={[50]} />);
    const thumbs = container.querySelectorAll('[data-radix-collection-item]');
    expect(thumbs.length).toBe(1);
  });

  it('renders two thumbs for range slider with two values', () => {
    const { container } = render(<Slider defaultValue={[25, 75]} />);
    const thumbs = container.querySelectorAll('[data-radix-collection-item]');
    expect(thumbs.length).toBe(2);
  });

  it('renders correct number of thumbs for controlled value', () => {
    const { container } = render(<Slider value={[10, 50, 90]} />);
    const thumbs = container.querySelectorAll('[data-radix-collection-item]');
    expect(thumbs.length).toBe(3);
  });

  it('renders with custom className', () => {
    const { container } = render(
      <Slider defaultValue={[50]} className="custom-class" />
    );
    const root = container.firstChild;
    expect(root).toHaveClass('custom-class');
  });

  it('renders track and range elements', () => {
    const { container } = render(<Slider defaultValue={[50]} />);
    
    // Check for track (bg-secondary)
    const track = container.querySelector('.bg-secondary');
    expect(track).toBeInTheDocument();
    
    // Check for range (bg-primary inside track)
    const range = container.querySelector('.bg-primary');
    expect(range).toBeInTheDocument();
  });

  it('applies disabled styles when disabled', () => {
    const { container } = render(<Slider defaultValue={[50]} disabled />);
    const root = container.firstChild as HTMLElement;
    expect(root).toHaveAttribute('data-disabled');
  });

  it('supports min and max props', () => {
    const { container } = render(
      <Slider defaultValue={[5]} min={0} max={10} />
    );
    const root = container.firstChild as HTMLElement;
    expect(root).toHaveAttribute('aria-valuemin', '0');
    expect(root).toHaveAttribute('aria-valuemax', '10');
  });

  it('supports step prop', () => {
    const { container } = render(
      <Slider defaultValue={[0.5]} step={0.1} min={0} max={1} />
    );
    const root = container.firstChild as HTMLElement;
    // Slider should render without errors with decimal step
    expect(root).toBeInTheDocument();
  });
});
