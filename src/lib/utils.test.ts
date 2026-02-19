import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateId } from './utils'

describe('utils', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('generateId', () => {
    it('should return a string', () => {
      const id = generateId()
      expect(typeof id).toBe('string')
      expect(id.length).toBeGreaterThan(0)
    })

    it('should use crypto.randomUUID if available', () => {
      const mockUUID = '123e4567-e89b-12d3-a456-426614174000'

      vi.stubGlobal('crypto', {
        randomUUID: vi.fn().mockReturnValue(mockUUID),
      })

      const id = generateId()
      expect(id).toBe(mockUUID)
      expect(crypto.randomUUID).toHaveBeenCalled()
    })

    it('should fallback to Math.random if crypto.randomUUID is unavailable', () => {
      vi.stubGlobal('crypto', {
        randomUUID: undefined,
      })

      const id = generateId()
      expect(typeof id).toBe('string')
      expect(id.length).toBeGreaterThan(10)
    })
  })
})
