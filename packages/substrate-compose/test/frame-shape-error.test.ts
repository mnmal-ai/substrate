import { describe, expect, it } from 'vitest';
import { frameShapeError } from '../src/routes/helpers.js';

describe('frameShapeError', () => {
  it('accepts a frame, a batch and an empty batch', () => {
    expect(frameShapeError({ 'ns/T': { params: {}, fields: { id: true } } })).toBeNull();
    expect(frameShapeError({ 'ns/createT': [{ params: {} }, { params: {} }] })).toBeNull();
    expect(frameShapeError({ 'ns/createT': [] })).toBeNull();
  });

  it('names a body that is not an object, with the frame shape', () => {
    expect(frameShapeError([])).toMatch(
      /^the body is array, not a frame: a frame is \{ "<ns>\/<Type>"/
    );
    expect(frameShapeError(null)).toMatch(/^the body is null/);
  });

  it('names the key whose entry is not an object, and lists idempotencyKey', () => {
    expect(frameShapeError({ 'ns/T': 'x' })).toMatch(
      /^'ns\/T' is string; each key maps to \{ params\?, fields\?, idempotencyKey\? \}/
    );
  });

  it('names the batch element that is not an object', () => {
    expect(frameShapeError({ 'ns/createT': [{ params: {} }, 3] })).toMatch(
      /^'ns\/createT'\[1\] is number/
    );
  });
});
