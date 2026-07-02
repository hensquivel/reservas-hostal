import { useState, useEffect, useMemo } from "react";
import { createClient } from "@supabase/supabase-js";
import { BedDouble, BedSingle, CalendarDays, Home, Plus, Trash2, Users, Check, X, DoorOpen } from "lucide-react";

// ---------- utilidades de fechas ----------
const hoy = () => new Date().toISOString().slice(0, 10);
const manana = () => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
};
const fmt = (s) => {
  if (!s) return "";
  const [y, m, d] = s.split("-");
  const meses = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  return `${parseInt(d)} ${meses[parseInt(m) - 1]} ${y}`;
};
const noches = (a, b) => Math.max(0, Math.round((new Date(b) - new Date(a)) / 86400000));
// dos rangos [in, out) se cruzan
const seCruzan = (aIn, aOut, bIn, bOut) => aIn < bOut && bIn < aOut;

// ---------- conexión a Supabase ----------
// Las credenciales se leen de variables de entorno (archivo .env en local, Settings en Vercel)
const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);

// mapeo entre columnas de la base (snake_case) y el formato de la app (camelCase)
const reservaDesdeDb = (r) => ({
  id: r.id,
  huesped: r.huesped,
  habitacionId: r.habitacion_id,
  camaIds: r.cama_ids,
  habitacionCompleta: r.habitacion_completa,
  entrada: r.entrada,
  salida: r.salida,
  creada: r.creada,
});

export default function AppReservasHostal() {
  const [datos, setDatos] = useState({ habitaciones: [], reservas: [] });
  const [cargando, setCargando] = useState(true);
  const [tab, setTab] = useState("reservar");
  const [aviso, setAviso] = useState(null);

  const mostrarAviso = (texto, error = false) => {
    setAviso({ texto, error });
    setTimeout(() => setAviso(null), 3000);
  };

  // ---- cargar todo desde la base ----
  const cargarDatos = async () => {
    const [habs, ress] = await Promise.all([
      supabase.from("habitaciones").select("*").order("creada"),
      supabase.from("reservas").select("*"),
    ]);
    if (habs.error || ress.error) {
      mostrarAviso("Error cargando datos. Revisa tu conexión.", true);
      return;
    }
    setDatos({
      habitaciones: habs.data.map((h) => ({ id: h.id, nombre: h.nombre, camas: h.camas })),
      reservas: ress.data.map(reservaDesdeDb),
    });
  };

  useEffect(() => {
    (async () => {
      await cargarDatos();
      setCargando(false);
    })();
    // tiempo real: cuando otro dispositivo cambia algo, recargamos
    const canal = supabase
      .channel("cambios-hostal")
      .on("postgres_changes", { event: "*", schema: "public", table: "habitaciones" }, cargarDatos)
      .on("postgres_changes", { event: "*", schema: "public", table: "reservas" }, cargarDatos)
      .subscribe();
    return () => supabase.removeChannel(canal);
  }, []);

  // ---- habitaciones ----
  const crearHabitacion = async (nombre, numCamas) => {
    const id = "h" + Date.now();
    const camas = Array.from({ length: numCamas }, (_, i) => ({
      id: id + "-c" + (i + 1),
      etiqueta: "Cama " + (i + 1),
    }));
    const { error } = await supabase.from("habitaciones").insert({ id, nombre, camas });
    if (error) return mostrarAviso("No se pudo crear la habitación.", true);
    await cargarDatos();
    mostrarAviso(`Habitación "${nombre}" creada con ${numCamas} camas`);
  };

  const eliminarHabitacion = async (id) => {
    // primero sus reservas, luego la habitación
    const r1 = await supabase.from("reservas").delete().eq("habitacion_id", id);
    const r2 = await supabase.from("habitaciones").delete().eq("id", id);
    if (r1.error || r2.error) return mostrarAviso("No se pudo eliminar.", true);
    await cargarDatos();
    mostrarAviso("Habitación eliminada");
  };

  const crearEjemplo = async () => {
    const base = Date.now();
    const mk = (nombre, n, off) => {
      const id = "h" + (base + off);
      return {
        id,
        nombre,
        camas: Array.from({ length: n }, (_, i) => ({ id: id + "-c" + (i + 1), etiqueta: "Cama " + (i + 1) })),
      };
    };
    const { error } = await supabase.from("habitaciones").insert([
      mk("Dormitorio Andes", 6, 1),
      mk("Dormitorio Caribe", 4, 2),
      mk("Privada Monserrate", 2, 3),
    ]);
    if (error) return mostrarAviso("No se pudieron crear los ejemplos.", true);
    await cargarDatos();
    mostrarAviso("Habitaciones de ejemplo creadas");
  };

  // ---- reservas ----
  const camasOcupadas = (habitacionId, entrada, salida, ignorarReservaId = null) => {
    const ocupadas = new Set();
    datos.reservas.forEach((r) => {
      if (r.id === ignorarReservaId) return;
      if (r.habitacionId !== habitacionId) return;
      if (seCruzan(entrada, salida, r.entrada, r.salida)) r.camaIds.forEach((c) => ocupadas.add(c));
    });
    return ocupadas;
  };

  const crearReserva = async (reserva) => {
    // verificación final contra la base para evitar dobles reservas simultáneas
    const { data: recientes, error: errCheck } = await supabase
      .from("reservas")
      .select("*")
      .eq("habitacion_id", reserva.habitacionId);
    if (errCheck) return mostrarAviso("Error de conexión. Intenta de nuevo.", true);
    const conflicto = recientes.some(
      (r) =>
        seCruzan(reserva.entrada, reserva.salida, r.entrada, r.salida) &&
        r.cama_ids.some((c) => reserva.camaIds.includes(c))
    );
    if (conflicto) {
      await cargarDatos();
      return mostrarAviso("Alguien acaba de reservar una de esas camas. Revisa de nuevo.", true);
    }
    const { error } = await supabase.from("reservas").insert({
      id: "r" + Date.now() + Math.random().toString(36).slice(2, 6),
      huesped: reserva.huesped,
      habitacion_id: reserva.habitacionId,
      cama_ids: reserva.camaIds,
      habitacion_completa: reserva.habitacionCompleta,
      entrada: reserva.entrada,
      salida: reserva.salida,
      creada: reserva.creada,
    });
    if (error) return mostrarAviso("No se pudo guardar la reserva.", true);
    await cargarDatos();
    mostrarAviso("Reserva confirmada para " + reserva.huesped);
  };

  const cancelarReserva = async (id) => {
    const { error } = await supabase.from("reservas").delete().eq("id", id);
    if (error) return mostrarAviso("No se pudo cancelar.", true);
    await cargarDatos();
    mostrarAviso("Reserva cancelada");
  };

  if (cargando)
    return (
      <div className="pantalla centro">
        <Estilos />
        <p className="cargando">Cargando tu hostal…</p>
      </div>
    );

  return (
    <div className="pantalla">
      <Estilos />
      <header className="cabecera">
        <div className="marca">
          <div className="logo"><DoorOpen size={22} /></div>
          <div>
            <h1>Recepción</h1>
            <p>Reservas del hostal</p>
          </div>
        </div>
        <nav className="tabs">
          <button className={tab === "reservar" ? "activo" : ""} onClick={() => setTab("reservar")}>
            <Plus size={16} /> Nueva reserva
          </button>
          <button className={tab === "reservas" ? "activo" : ""} onClick={() => setTab("reservas")}>
            <CalendarDays size={16} /> Reservas
          </button>
          <button className={tab === "habitaciones" ? "activo" : ""} onClick={() => setTab("habitaciones")}>
            <Home size={16} /> Habitaciones
          </button>
        </nav>
      </header>

      <main className="contenido">
        {tab === "reservar" && (
          <NuevaReserva
            datos={datos}
            camasOcupadas={camasOcupadas}
            onCrear={crearReserva}
            irAHabitaciones={() => setTab("habitaciones")}
          />
        )}
        {tab === "reservas" && <ListaReservas datos={datos} onCancelar={cancelarReserva} />}
        {tab === "habitaciones" && (
          <Habitaciones
            datos={datos}
            onCrear={crearHabitacion}
            onEliminar={eliminarHabitacion}
            onEjemplo={crearEjemplo}
          />
        )}
      </main>

      {aviso && <div className={"aviso" + (aviso.error ? " error" : "")}>{aviso.texto}</div>}
    </div>
  );
}

// ================= NUEVA RESERVA =================
function NuevaReserva({ datos, camasOcupadas, onCrear, irAHabitaciones }) {
  const [entrada, setEntrada] = useState(hoy());
  const [salida, setSalida] = useState(manana());
  const [huesped, setHuesped] = useState("");
  const [seleccion, setSeleccion] = useState({}); // { habitacionId: Set(camaId) }

  const fechasValidas = entrada && salida && salida > entrada;
  const n = noches(entrada, salida);

  const alternarCama = (habId, camaId) => {
    setSeleccion((s) => {
      const set = new Set(s[habId] || []);
      set.has(camaId) ? set.delete(camaId) : set.add(camaId);
      const nuevo = { ...s, [habId]: set };
      if (set.size === 0) delete nuevo[habId];
      return nuevo;
    });
  };

  const seleccionarHabitacion = (hab, ocupadas) => {
    const libres = hab.camas.filter((c) => !ocupadas.has(c.id)).map((c) => c.id);
    setSeleccion((s) => {
      const actual = s[hab.id] ? s[hab.id].size : 0;
      const nuevo = { ...s };
      if (actual === libres.length && libres.length > 0) delete nuevo[hab.id];
      else nuevo[hab.id] = new Set(libres);
      return nuevo;
    });
  };

  const totalCamas = Object.values(seleccion).reduce((a, s) => a + s.size, 0);

  const confirmar = () => {
    Object.entries(seleccion).forEach(([habId, set]) => {
      const hab = datos.habitaciones.find((h) => h.id === habId);
      const camaIds = [...set];
      onCrear({
        huesped: huesped.trim(),
        habitacionId: habId,
        camaIds,
        habitacionCompleta: camaIds.length === hab.camas.length,
        entrada,
        salida,
        creada: new Date().toISOString(),
      });
    });
    setSeleccion({});
    setHuesped("");
  };

  if (datos.habitaciones.length === 0)
    return (
      <div className="vacio">
        <BedDouble size={40} />
        <h2>Aún no hay habitaciones</h2>
        <p>Crea tus habitaciones primero y luego podrás recibir reservas.</p>
        <button className="btn primario" onClick={irAHabitaciones}>Crear habitaciones</button>
      </div>
    );

  return (
    <div>
      <section className="panel fechas">
        <div className="campo">
          <label>Entrada</label>
          <input type="date" value={entrada} min={hoy()} onChange={(e) => { setEntrada(e.target.value); setSeleccion({}); }} />
        </div>
        <div className="campo">
          <label>Salida</label>
          <input type="date" value={salida} min={entrada} onChange={(e) => { setSalida(e.target.value); setSeleccion({}); }} />
        </div>
        <div className="campo">
          <label>Huésped</label>
          <input type="text" placeholder="Nombre del huésped" value={huesped} onChange={(e) => setHuesped(e.target.value)} />
        </div>
        <div className="resumen-noches">
          {fechasValidas ? (
            <span><strong>{n}</strong> {n === 1 ? "noche" : "noches"}</span>
          ) : (
            <span className="alerta">La salida debe ser después de la entrada</span>
          )}
        </div>
      </section>

      <p className="pista">Toca las camas libres para seleccionarlas, o usa «Habitación completa».</p>

      <div className="lista-habitaciones">
        {datos.habitaciones.map((hab) => {
          const ocupadas = fechasValidas ? camasOcupadas(hab.id, entrada, salida) : new Set();
          const sel = seleccion[hab.id] || new Set();
          const libres = hab.camas.length - ocupadas.size;
          const todaSel = sel.size === libres && libres > 0;
          return (
            <section key={hab.id} className="panel habitacion">
              <div className="hab-cabecera">
                <div>
                  <h3>{hab.nombre}</h3>
                  <p className={libres === 0 ? "sin-cupo" : ""}>
                    {libres === 0 ? "Sin camas libres en estas fechas" : `${libres} de ${hab.camas.length} camas libres`}
                  </p>
                </div>
                <button
                  className={"btn chico" + (todaSel ? " primario" : "")}
                  disabled={!fechasValidas || libres === 0}
                  onClick={() => seleccionarHabitacion(hab, ocupadas)}
                >
                  {todaSel ? <><Check size={14} /> Completa</> : "Habitación completa"}
                </button>
              </div>
              <div className="mapa-camas">
                {hab.camas.map((cama) => {
                  const ocupada = ocupadas.has(cama.id);
                  const activa = sel.has(cama.id);
                  return (
                    <button
                      key={cama.id}
                      className={"cama" + (ocupada ? " ocupada" : "") + (activa ? " activa" : "")}
                      disabled={!fechasValidas || ocupada}
                      onClick={() => alternarCama(hab.id, cama.id)}
                      title={ocupada ? "Ocupada en estas fechas" : cama.etiqueta}
                    >
                      <BedSingle size={20} />
                      <span>{cama.etiqueta}</span>
                      <em>{ocupada ? "Ocupada" : activa ? "Elegida" : "Libre"}</em>
                    </button>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>

      {totalCamas > 0 && (
        <div className="barra-confirmar">
          <div>
            <strong>{totalCamas}</strong> {totalCamas === 1 ? "cama" : "camas"} · {fmt(entrada)} → {fmt(salida)}
            {!huesped.trim() && <span className="alerta"> · escribe el nombre del huésped</span>}
          </div>
          <button className="btn primario" disabled={!huesped.trim() || !fechasValidas} onClick={confirmar}>
            Confirmar reserva
          </button>
        </div>
      )}
    </div>
  );
}

// ================= LISTA DE RESERVAS =================
function ListaReservas({ datos, onCancelar }) {
  const [confirmando, setConfirmando] = useState(null);
  const ordenadas = useMemo(
    () => [...datos.reservas].sort((a, b) => (a.entrada < b.entrada ? -1 : 1)),
    [datos.reservas]
  );
  const nombreHab = (id) => datos.habitaciones.find((h) => h.id === id)?.nombre || "Habitación eliminada";
  const h = hoy();

  if (ordenadas.length === 0)
    return (
      <div className="vacio">
        <CalendarDays size={40} />
        <h2>Sin reservas todavía</h2>
        <p>Cuando confirmes una reserva aparecerá aquí.</p>
      </div>
    );

  return (
    <div className="lista-reservas">
      {ordenadas.map((r) => {
        const pasada = r.salida <= h;
        const enCurso = r.entrada <= h && r.salida > h;
        return (
          <section key={r.id} className={"panel reserva" + (pasada ? " pasada" : "")}>
            <div className="reserva-info">
              <div className="reserva-titulo">
                <Users size={16} />
                <strong>{r.huesped}</strong>
                {enCurso && <span className="etiqueta encurso">En curso</span>}
                {pasada && <span className="etiqueta">Finalizada</span>}
                {r.habitacionCompleta && <span className="etiqueta completa">Habitación completa</span>}
              </div>
              <p>
                {nombreHab(r.habitacionId)} · {r.camaIds.length} {r.camaIds.length === 1 ? "cama" : "camas"} ·{" "}
                {fmt(r.entrada)} → {fmt(r.salida)} ({noches(r.entrada, r.salida)}{" "}
                {noches(r.entrada, r.salida) === 1 ? "noche" : "noches"})
              </p>
            </div>
            {confirmando === r.id ? (
              <div className="acciones">
                <button className="btn chico peligro" onClick={() => { onCancelar(r.id); setConfirmando(null); }}>
                  <Check size={14} /> Sí, cancelar
                </button>
                <button className="btn chico" onClick={() => setConfirmando(null)}><X size={14} /> No</button>
              </div>
            ) : (
              <button className="btn chico" onClick={() => setConfirmando(r.id)}>
                <Trash2 size={14} /> Cancelar
              </button>
            )}
          </section>
        );
      })}
    </div>
  );
}

// ================= HABITACIONES =================
function Habitaciones({ datos, onCrear, onEliminar, onEjemplo }) {
  const [nombre, setNombre] = useState("");
  const [numCamas, setNumCamas] = useState(4);
  const [confirmando, setConfirmando] = useState(null);

  const crear = () => {
    if (!nombre.trim() || numCamas < 1) return;
    onCrear(nombre.trim(), Math.min(20, Math.max(1, Math.round(numCamas))));
    setNombre("");
    setNumCamas(4);
  };

  return (
    <div>
      <section className="panel formulario">
        <h3>Nueva habitación</h3>
        <div className="fila-form">
          <div className="campo crece">
            <label>Nombre</label>
            <input type="text" placeholder="Ej: Dormitorio Andes" value={nombre} onChange={(e) => setNombre(e.target.value)} />
          </div>
          <div className="campo">
            <label>Camas (1–20)</label>
            <input type="number" min={1} max={20} value={numCamas} onChange={(e) => setNumCamas(parseInt(e.target.value) || 1)} />
          </div>
          <button className="btn primario" disabled={!nombre.trim()} onClick={crear}>
            <Plus size={16} /> Crear
          </button>
        </div>
      </section>

      {datos.habitaciones.length === 0 ? (
        <div className="vacio">
          <Home size={40} />
          <h2>Configura tu hostal</h2>
          <p>Crea cada habitación con su número de camas, o empieza con un ejemplo.</p>
          <button className="btn" onClick={onEjemplo}>Crear habitaciones de ejemplo</button>
        </div>
      ) : (
        <div className="lista-habitaciones">
          {datos.habitaciones.map((hab) => {
            const reservasHab = datos.reservas.filter((r) => r.habitacionId === hab.id && r.salida > hoy()).length;
            return (
              <section key={hab.id} className="panel habitacion">
                <div className="hab-cabecera">
                  <div>
                    <h3>{hab.nombre}</h3>
                    <p>
                      {hab.camas.length} {hab.camas.length === 1 ? "cama" : "camas"}
                      {reservasHab > 0 && ` · ${reservasHab} ${reservasHab === 1 ? "reserva activa" : "reservas activas"}`}
                    </p>
                  </div>
                  {confirmando === hab.id ? (
                    <div className="acciones">
                      <button className="btn chico peligro" onClick={() => { onEliminar(hab.id); setConfirmando(null); }}>
                        <Check size={14} /> Eliminar todo
                      </button>
                      <button className="btn chico" onClick={() => setConfirmando(null)}><X size={14} /> No</button>
                    </div>
                  ) : (
                    <button className="btn chico" onClick={() => setConfirmando(hab.id)}>
                      <Trash2 size={14} /> Eliminar
                    </button>
                  )}
                </div>
                {confirmando === hab.id && reservasHab > 0 && (
                  <p className="alerta">Al eliminar la habitación también se borran sus reservas.</p>
                )}
                <div className="mapa-camas mini">
                  {hab.camas.map((c) => (
                    <div key={c.id} className="cama estatica">
                      <BedSingle size={18} />
                      <span>{c.etiqueta}</span>
                    </div>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ================= ESTILOS =================
function Estilos() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@500;700&family=Public+Sans:wght@400;500;600&display=swap');
      :root {
        --tinta: #1d2b25;
        --fondo: #edefe7;
        --panel: #ffffff;
        --verde: #2e5844;
        --verde-suave: #dfe9e0;
        --ambar: #f2a93b;
        --ambar-oscuro: #b87715;
        --rojo: #c9503f;
        --gris: #6b7a72;
        --borde: #d8dcd2;
      }
      * { box-sizing: border-box; }
      .pantalla {
        min-height: 100vh; background: var(--fondo); color: var(--tinta);
        font-family: 'Public Sans', system-ui, sans-serif; padding-bottom: 90px;
      }
      .pantalla.centro { display:flex; align-items:center; justify-content:center; }
      .cargando { color: var(--gris); }
      .cabecera {
        background: var(--verde); color: #fff; padding: 20px 20px 0;
      }
      .marca { display:flex; align-items:center; gap:12px; max-width:860px; margin:0 auto 16px; }
      .logo {
        width:42px; height:42px; border-radius:12px; background: var(--ambar); color: var(--tinta);
        display:flex; align-items:center; justify-content:center; flex-shrink:0;
      }
      .marca h1 { font-family:'Bricolage Grotesque', sans-serif; font-size:22px; margin:0; line-height:1.1; }
      .marca p { margin:0; font-size:13px; opacity:.75; }
      .tabs { display:flex; gap:4px; max-width:860px; margin:0 auto; overflow-x:auto; }
      .tabs button {
        display:flex; align-items:center; gap:6px; border:none; background:transparent; color:#fff;
        opacity:.7; padding:10px 14px; font:inherit; font-size:14px; font-weight:600; cursor:pointer;
        border-radius:10px 10px 0 0; white-space:nowrap;
      }
      .tabs button.activo { background: var(--fondo); color: var(--tinta); opacity:1; }
      .tabs button:focus-visible { outline:2px solid var(--ambar); outline-offset:-2px; }
      .contenido { max-width:860px; margin:20px auto 0; padding:0 16px; }
      .panel {
        background: var(--panel); border:1px solid var(--borde); border-radius:14px;
        padding:16px; margin-bottom:14px;
      }
      .fechas { display:flex; gap:14px; flex-wrap:wrap; align-items:flex-end; }
      .campo { display:flex; flex-direction:column; gap:5px; }
      .campo.crece { flex:1; min-width:180px; }
      .campo label { font-size:12px; font-weight:600; color:var(--gris); text-transform:uppercase; letter-spacing:.04em; }
      .campo input {
        border:1px solid var(--borde); border-radius:9px; padding:9px 11px; font:inherit; font-size:14px;
        background:#fff; color:var(--tinta); min-width:140px;
      }
      .campo input:focus { outline:2px solid var(--verde); outline-offset:-1px; }
      .resumen-noches { font-size:14px; color:var(--gris); padding-bottom:9px; }
      .resumen-noches strong { color:var(--tinta); font-size:16px; }
      .pista { font-size:13px; color:var(--gris); margin:0 2px 12px; }
      .hab-cabecera { display:flex; justify-content:space-between; align-items:flex-start; gap:10px; flex-wrap:wrap; margin-bottom:12px; }
      .hab-cabecera h3 { font-family:'Bricolage Grotesque', sans-serif; margin:0 0 2px; font-size:17px; }
      .hab-cabecera p { margin:0; font-size:13px; color:var(--gris); }
      .hab-cabecera p.sin-cupo { color: var(--rojo); font-weight:600; }
      .mapa-camas { display:grid; grid-template-columns:repeat(auto-fill, minmax(110px, 1fr)); gap:8px; }
      .mapa-camas.mini { grid-template-columns:repeat(auto-fill, minmax(90px, 1fr)); }
      .cama {
        border:1.5px solid var(--borde); border-radius:11px; background:var(--verde-suave);
        padding:10px 8px; display:flex; flex-direction:column; align-items:center; gap:3px;
        font:inherit; cursor:pointer; color:var(--tinta); transition: transform .08s, border-color .08s;
      }
      .cama span { font-size:12px; font-weight:600; }
      .cama em { font-style:normal; font-size:11px; color:var(--gris); }
      .cama:not(:disabled):hover { transform: translateY(-2px); border-color: var(--verde); }
      .cama:focus-visible { outline:2px solid var(--verde); outline-offset:2px; }
      .cama.activa { background: var(--ambar); border-color: var(--ambar-oscuro); }
      .cama.activa em { color: var(--ambar-oscuro); font-weight:600; }
      .cama.ocupada { background:#f3e4e1; border-color:#e3c4bf; color:#9c6b62; cursor:not-allowed; opacity:.85; }
      .cama.ocupada em { color: var(--rojo); }
      .cama.estatica { cursor:default; background:#f4f6f0; }
      .cama.estatica:hover { transform:none; border-color:var(--borde); }
      .btn {
        display:inline-flex; align-items:center; gap:6px; border:1.5px solid var(--borde);
        background:#fff; color:var(--tinta); border-radius:10px; padding:9px 14px;
        font:inherit; font-size:14px; font-weight:600; cursor:pointer;
      }
      .btn:hover:not(:disabled) { border-color: var(--verde); }
      .btn:focus-visible { outline:2px solid var(--verde); outline-offset:2px; }
      .btn:disabled { opacity:.45; cursor:not-allowed; }
      .btn.primario { background: var(--verde); border-color: var(--verde); color:#fff; }
      .btn.primario:hover:not(:disabled) { background:#254936; }
      .btn.peligro { background: var(--rojo); border-color: var(--rojo); color:#fff; }
      .btn.chico { padding:6px 10px; font-size:13px; }
      .fila-form { display:flex; gap:12px; flex-wrap:wrap; align-items:flex-end; }
      .formulario h3 { font-family:'Bricolage Grotesque', sans-serif; margin:0 0 12px; font-size:16px; }
      .barra-confirmar {
        position:fixed; left:0; right:0; bottom:0; background:var(--tinta); color:#fff;
        display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap;
        padding:14px 20px; font-size:14px; z-index:10;
      }
      .barra-confirmar .alerta { color:#f0b9ae; }
      .alerta { color: var(--rojo); font-size:13px; }
      .vacio {
        text-align:center; padding:50px 20px; color:var(--gris);
        display:flex; flex-direction:column; align-items:center; gap:8px;
      }
      .vacio h2 { font-family:'Bricolage Grotesque', sans-serif; color:var(--tinta); margin:6px 0 0; font-size:20px; }
      .vacio p { margin:0 0 12px; font-size:14px; max-width:340px; }
      .reserva { display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap; }
      .reserva.pasada { opacity:.55; }
      .reserva-titulo { display:flex; align-items:center; gap:7px; flex-wrap:wrap; margin-bottom:4px; }
      .reserva-info p { margin:0; font-size:13.5px; color:var(--gris); }
      .etiqueta {
        font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.04em;
        background:var(--fondo); color:var(--gris); border-radius:6px; padding:2px 7px;
      }
      .etiqueta.encurso { background:var(--verde-suave); color:var(--verde); }
      .etiqueta.completa { background:#fdeed3; color:var(--ambar-oscuro); }
      .acciones { display:flex; gap:6px; }
      .aviso {
        position:fixed; bottom:80px; left:50%; transform:translateX(-50%);
        background:var(--verde); color:#fff; border-radius:12px; padding:11px 18px;
        font-size:14px; font-weight:600; box-shadow:0 6px 18px rgba(0,0,0,.18); z-index:20;
        max-width:90vw; text-align:center;
      }
      .aviso.error { background: var(--rojo); }
      @media (prefers-reduced-motion: reduce) { .cama { transition:none; } }
    `}</style>
  );
}
