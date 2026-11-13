// Practice form: never sends anything; just confirms the run-through.
document.getElementById("application").addEventListener("submit", (event) => {
  event.preventDefault();
  const done = document.getElementById("doneMsg");
  done.classList.add("show");
  done.scrollIntoView({ behavior: "smooth", block: "center" });
});
