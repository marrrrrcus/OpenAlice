/**
 * useSchemaForm — parses a JSON Schema into form field descriptors and manages form state.
 *
 * Separates const fields (hidden, auto-merged on submit) from editable fields.
 * Components just iterate `fields` and render by `type`.
 */

import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import type { JsonSchema, JsonSchemaProperty } from '../api/types'

// ==================== Types ====================

export interface SchemaField {
  key: string
  type: 'text' | 'password' | 'select' | 'checkbox'
  title: string
  description?: string
  required: boolean
  options?: Array<{ value: string; label: string }>
  defaultValue?: string
}

interface UseSchemaFormResult {
  /** Editable fields (const fields excluded). */
  fields: SchemaField[]
  /** Current form values for editable fields. */
  formData: Record<string, string>
  /** Update a single field value. */
  setField: (key: string, value: string) => void
  /** Get submit-ready data: editable values + const values merged. */
  getSubmitData: () => Record<string, unknown>
  /** Validate required fields. Returns error message or null. */
  validate: () => string | null
}

// ==================== Hook ====================

export function useSchemaForm(
  schema: JsonSchema | undefined,
  initialValues?: Record<string, string>,
): UseSchemaFormResult {
  // Parse schema into const values and editable field descriptors
  const { constValues, fieldDefs, defaults } = useMemo(() => {
    const consts: Record<string, unknown> = {}
    const fields: SchemaField[] = []
    const defs: Record<string, string> = {}

    const props = (schema?.properties ?? {}) as Record<string, JsonSchemaProperty>
    const required = new Set((schema?.required as string[]) ?? [])

    for (const [key, prop] of Object.entries(props)) {
      // const → hidden, value auto-merged
      if (prop.const !== undefined) {
        consts[key] = prop.const
        continue
      }

      const title = prop.title ?? key.charAt(0).toUpperCase() + key.slice(1)
      const isRequired = required.has(key)

      // Determine field type
      if (prop.writeOnly) {
        fields.push({ key, type: 'password', title, description: prop.description, required: isRequired })
      } else if (prop.oneOf) {
        const options = prop.oneOf.map(o => ({ value: o.const, label: o.title }))
        fields.push({ key, type: 'select', title, description: prop.description, required: isRequired, options })
      } else if (prop.enum) {
        const options = prop.enum.map(v => ({ value: v, label: v }))
        fields.push({ key, type: 'select', title, description: prop.description, required: isRequired, options })
      } else if (prop.type === 'boolean') {
        fields.push({ key, type: 'checkbox', title, description: prop.description, required: isRequired })
      } else {
        fields.push({ key, type: 'text', title, description: prop.description, required: isRequired, defaultValue: prop.default !== undefined ? String(prop.default) : undefined })
      }

      // Collect defaults
      if (prop.default !== undefined) {
        defs[key] = String(prop.default)
      }
    }

    return { constValues: consts, fieldDefs: fields, defaults: defs }
  }, [schema])

  // Form state — reset when schema changes (e.g. user picks a different preset)
  const [formData, setFormData] = useState<Record<string, string>>(() => ({
    ...defaults,
    ...(initialValues ?? {}),
  }))

  // Re-initialize when defaults change (schema switch)
  const prevDefaults = useRef(defaults)
  useEffect(() => {
    if (prevDefaults.current !== defaults) {
      prevDefaults.current = defaults
      setFormData({ ...defaults, ...(initialValues ?? {}) })
    }
  }, [defaults, initialValues])

  const setField = useCallback((key: string, value: string) => {
    setFormData(prev => ({ ...prev, [key]: value }))
  }, [])

  const getSubmitData = useCallback((): Record<string, unknown> => {
    const checkboxKeys = new Set(fieldDefs.filter(f => f.type === 'checkbox').map(f => f.key))
    const result: Record<string, unknown> = { ...constValues }
    for (const [key, value] of Object.entries(formData)) {
      if (key.endsWith('__custom')) continue
      if (checkboxKeys.has(key)) {
        result[key] = value === 'true'
      } else if (value !== '' && value !== undefined) {
        result[key] = value
      }
    }
    return result
  }, [constValues, formData, fieldDefs])

  const validate = useCallback((): string | null => {
    for (const field of fieldDefs) {
      if (field.required && !formData[field.key]?.trim()) {
        return `${field.title} is required`
      }
    }
    return null
  }, [fieldDefs, formData])

  return { fields: fieldDefs, formData, setField, getSubmitData, validate }
}
