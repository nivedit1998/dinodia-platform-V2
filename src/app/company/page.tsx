import { redirect } from "next/navigation";

export default function CompanyPage() {
  redirect("/company/login" as never);
}
