import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // Create company settings
  const company = await prisma.companySettings.upsert({
    where: { id: 'default' },
    update: {},
    create: {
      id: 'default',
      companyName: 'SpotOnRoof',
      companyAddress: '130 E Wilson Bridge Rd Suite 300, Worthington, OH 43085',
      companyPhone: '(614) 832-0273',
      companyWebsite: 'https://spotonroof.com',
      companyInstagram: 'https://instagram.com/spotonroof',
      companyFacebook: 'https://facebook.com/spotonroof',
      companyLinkedIn: 'https://linkedin.com/company/spotonroof',
      companyTikTok: 'https://tiktok.com/@spotonroof',
      inviteCode: 'SPOTON2024',
      brandPrimaryColor: '#00AEEF',
      brandSecondaryColor: '#0A7E8C',
    },
  });

  console.log('Created company settings:', company.companyName);

  // Create standalone admin account (no public card)
  await prisma.rep.upsert({
    where: { email: 'admin@spotonroof.com' },
    update: {},
    create: {
      email: 'admin@spotonroof.com',
      firstName: 'Admin',
      lastName: 'SpotOnRoof',
      slug: 'admin',
      role: 'admin',
      isActive: false,
    },
  });

  await prisma.user.upsert({
    where: { email: 'admin@spotonroof.com' },
    update: {},
    create: {
      email: 'admin@spotonroof.com',
      name: 'Admin',
    },
  });

  console.log('Created standalone admin: admin@spotonroof.com');

  // Reps are never seeded: they come only from the live roster (admin dashboard, Sync Roster).

  console.log('Seed complete!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
