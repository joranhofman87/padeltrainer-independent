import { describe, it, expect } from 'vitest';
import { cn } from './utils';

describe('cn utility', () => {
  it('merges simple class names', () => {
    expect(cn('foo', 'bar')).toBe('foo bar');
  });

  it('handles conditional classes', () => {
    expect(cn('base', true && 'active', false && 'disabled')).toBe('base active');
  });

  it('handles undefined and null', () => {
    expect(cn('base', undefined, null, 'end')).toBe('base end');
  });

  it('handles arrays of classes', () => {
    expect(cn(['one', 'two'], 'three')).toBe('one two three');
  });

  it('handles objects with boolean values', () => {
    expect(cn({ active: true, disabled: false, visible: true })).toBe('active visible');
  });

  it('merges tailwind conflicting classes correctly', () => {
    // tailwind-merge should keep only the last conflicting class
    expect(cn('px-2', 'px-4')).toBe('px-4');
    expect(cn('text-red-500', 'text-blue-500')).toBe('text-blue-500');
    expect(cn('mt-2', 'mt-4')).toBe('mt-4');
  });

  it('preserves non-conflicting tailwind classes', () => {
    expect(cn('px-2', 'py-4', 'mt-2')).toBe('px-2 py-4 mt-2');
  });

  it('handles complex tailwind class combinations', () => {
    expect(cn(
      'flex items-center',
      'justify-between',
      true && 'p-4',
      false && 'hidden'
    )).toBe('flex items-center justify-between p-4');
  });

  it('handles empty input', () => {
    expect(cn()).toBe('');
    expect(cn('')).toBe('');
  });

  it('handles responsive tailwind classes', () => {
    expect(cn('md:px-2', 'md:px-4')).toBe('md:px-4');
    expect(cn('sm:text-sm', 'lg:text-lg')).toBe('sm:text-sm lg:text-lg');
  });

  it('handles state variants', () => {
    expect(cn('hover:bg-red-500', 'hover:bg-blue-500')).toBe('hover:bg-blue-500');
    expect(cn('focus:ring-2', 'active:ring-4')).toBe('focus:ring-2 active:ring-4');
  });
});
