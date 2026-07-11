import { prisma } from '../src/config/prisma.js'
import { writeAuditLog } from '../src/lib/auditLog.js'

const SEED_SUBJECTS = [
  { group: 'SAMSUNG_EMPLOYEE', fullName: 'Ravi Kumar', email: 'ravi.kumar@samsung.example', employeeRef: 'EMP-1001', registrationChannel: 'AGENT' },
  { group: 'EX_SAMSUNG_EMPLOYEE', fullName: 'Anita Desai', email: 'anita.desai@samsung.example', employeeRef: 'EMP-1002', registrationChannel: 'SELF' },
  { group: 'SEED_LAB_EMPLOYEE', fullName: 'Karthik Raman', email: 'karthik.raman@seedlab.example', employeeRef: 'SL-2001', registrationChannel: 'AGENT' },
  { group: 'EX_SEED_LAB_EMPLOYEE', fullName: 'Priya Nair', email: 'priya.nair@seedlab.example', employeeRef: 'SL-2002', registrationChannel: 'SELF' },
  { group: 'VOLUNTEER', fullName: 'Sameer Joshi', email: 'sameer.joshi@example.com', employeeRef: null, registrationChannel: 'SELF' },
]

async function main() {
  for (const subject of SEED_SUBJECTS) {
    const created = await prisma.subject.upsert({
      where: { email: subject.email },
      update: {},
      create: subject,
    })

    await writeAuditLog({
      entityType: 'Subject',
      entityId: created.masterUserId,
      action: 'CREATE',
      payload: { group: created.group, registrationChannel: created.registrationChannel, seeded: true },
    })
  }

  console.log(`Seeded ${SEED_SUBJECTS.length} subjects across all 5 groups.`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
