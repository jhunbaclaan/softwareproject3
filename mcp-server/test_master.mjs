import { createOfflineDocument } from "@audiotool/nexus";

async function main() {
  const nexus = await createOfflineDocument();
  let masterId;
  await nexus.modify((t) => {
    const master = t.create("mixerMaster", {});
    if (!master) {
      console.log("Failed to create mixerMaster");
      return;
    }
    masterId = master.id;
    console.log("Created mixerMaster");
  });

  const entities = nexus.queryEntities.get();
  const master = entities.find(e => e.id === masterId);
  
  if (master) {
    console.log("Master fields:");
    for (const [key, field] of Object.entries(master.fields)) {
      if (field && typeof field === 'object' && 'value' in field) {
        console.log(` - ${key}: [Value] ${field.value}`);
      } else if (field && typeof field === 'object' && 'location' in field) {
        console.log(` - ${key}: [Socket]`);
      } else {
        console.log(` - ${key}: [Other]`);
      }
    }
  }
}

main().catch(console.error);
