import { describe, it, expect } from 'vitest'
import { isCloudSyncedPath } from './cloud-sync.js'

describe('isCloudSyncedPath', () => {
  it('flags OneDrive paths case-insensitively, passes local paths', () => {
    expect(isCloudSyncedPath('C:\\Users\\M\\OneDrive\\Desktop\\x')).toBe(true)
    expect(isCloudSyncedPath('/home/m/onedrive/data')).toBe(true)
    expect(isCloudSyncedPath('C:\\Users\\M\\Desktop\\Open Alice\\data')).toBe(false)
  })
})
