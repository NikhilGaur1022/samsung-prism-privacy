import { Router } from 'express'
import { requireAdminAuth } from '../../middleware/requireAdminAuth.js'
import {
  DATA_TYPE_CATALOG,
  MAX_CUSTOM_LENGTH,
  OTHER_PREFIX,
  groupedCatalog,
} from '../../lib/dataTypes.js'

// The picker's vocabulary, served rather than duplicated.
//
// Both portals need this list: the DPO picks it on a consent notice, the data
// owner picks a subset of it on a project, and the two are compared at approval.
// Hard-coding it in each portal would put three copies in the repository, and the
// copy that drifts is the one that makes a lawful project unapprovable.
export const dataTypeRoutes = Router()

// Admin-only, but no role floor beyond that: every admin role either authors this
// list or reads it back on a screen. It is a vocabulary, not anyone's data.
dataTypeRoutes.use(requireAdminAuth)

dataTypeRoutes.get('/', (_req, res) => {
  res.json({
    dataTypes: DATA_TYPE_CATALOG,
    groups: groupedCatalog(),
    // The client needs both to build the "Other" box and to round-trip a stored
    // custom value back into it.
    otherPrefix: OTHER_PREFIX,
    maxCustomLength: MAX_CUSTOM_LENGTH,
  })
})
